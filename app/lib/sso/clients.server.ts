/**
 * The applications that sign people in through the workspace (single sign-on, docs/SSO.md): their registration under
 * Settings → Applications, their secrets, who may sign in to each (everyone, or the people on its list, each with an
 * optional role) and the account menu's Apps. The identity provider (`provider.server.ts`) reads them through
 * `findClient`, `clientAccessFor` and the URI checks.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { oauthClientMembers, oauthClients, users } from "~/db/schema";
import type { OauthClient, User } from "~/db/schema";
import { constantTimeEqual, randomToken, sha256Hex } from "~/lib/crypto";
import { stringList } from "~/lib/guards";
import { newId } from "~/lib/ids";

import { SSO_PATHS } from "./paths";

/** A mistake an admin can correct on the Applications tab. */
export class SsoAdminError extends Error {
  override name = "SsoAdminError";
}

export type ClientAccess = OauthClient["access"];

export interface SsoClientView {
  id: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  launchUrl: string | null;
  pkceRequired: boolean;
  /** Everyone with an active mailbox, or only the people on the application's list. */
  access: ClientAccess;
  active: boolean;
  createdAt: string;
}

/** A person on an application's list, with the role the application reads from the ID token. */
export interface ClientMemberView {
  userId: string;
  email: string;
  name: string;
  role: string | null;
  active: boolean;
}

export interface SsoClientInput {
  name: string;
  /** One per line (or comma-separated). */
  redirectUris: string;
  postLogoutRedirectUris: string;
  launchUrl: string;
  pkceRequired: boolean;
  access: ClientAccess;
}

const SECRET_PREFIX = "wss_";

/** The exact form a URI is kept and compared in: as `URL` serialises it, so `https://a.test` and `https://a.test/` agree. */
export const normaliseUri = (value: string | null | undefined): string | null =>
  (value && URL.parse(value)?.href) || null;

const isLocalHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname.endsWith(".localhost");

/** Absolute https URLs (http only on localhost), without a fragment, deduplicated. */
export const parseUriList = (
  text: string,
  options: { allowEmpty?: boolean } = {}
): string[] => {
  const out: string[] = [];

  for (const raw of text.split(/[\s,]+/u)) {
    const value = raw.trim();

    if (!value) {
      continue;
    }

    const url = URL.parse(value);

    if (!url) {
      throw new SsoAdminError(`"${value}" is not an absolute URL.`);
    }

    if (url.hash) {
      throw new SsoAdminError(
        `"${value}" has a fragment; a redirect URI cannot.`
      );
    }

    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLocalHost(url.hostname))
    ) {
      throw new SsoAdminError(
        `"${value}" must use https (http only on localhost).`
      );
    }

    if (!out.includes(url.href)) {
      out.push(url.href);
    }
  }

  if (!out.length && !options.allowEmpty) {
    throw new SsoAdminError("At least one redirect URI is needed.");
  }

  return out;
};

const parseLaunchUrl = (text: string): string | null => {
  const [url] = parseUriList(text.trim(), { allowEmpty: true });

  return url ?? null;
};

const parseName = (text: string): string => {
  const name = text.trim();

  if (!name) {
    throw new SsoAdminError("A name is needed.");
  }

  if (name.length > 80) {
    throw new SsoAdminError("A name has at most 80 characters.");
  }

  return name;
};

/** A JSON list of URIs as this module wrote it; anything else is none. */
const uris = (json: string): string[] => {
  try {
    return stringList(JSON.parse(json));
  } catch {
    return [];
  }
};

export const clientView = (row: OauthClient): SsoClientView => ({
  id: row.id,
  name: row.name,
  redirectUris: uris(row.redirectUrisJson),
  postLogoutRedirectUris: uris(row.postLogoutRedirectUrisJson),
  launchUrl: row.launchUrl,
  pkceRequired: row.pkceRequired,
  access: row.access,
  active: row.active,
  createdAt: row.createdAt,
});

/** A role as an application's list keeps it: lower-case, short, or none. */
export const parseRole = (text: string | null | undefined): string | null => {
  const role = (text ?? "").trim().toLowerCase();

  if (!role) {
    return null;
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/u.test(role)) {
    throw new SsoAdminError(
      "A role is up to 40 letters, digits, dashes or underscores."
    );
  }

  return role;
};

export const listClients = async (db: Database): Promise<SsoClientView[]> => {
  const rows = await db.query.oauthClients.findMany({
    orderBy: [asc(oauthClients.createdAt)],
  });

  return rows.map(clientView);
};

/** The client row by id, active or not; the caller decides what an inactive one may do. */
export const findClient = async (
  db: Database,
  id: string
): Promise<OauthClient | null> => {
  if (!id) {
    return null;
  }

  return (
    (await db.query.oauthClients.findFirst({
      where: eq(oauthClients.id, id),
    })) ?? null
  );
};

const requireClient = async (db: Database, id: string) => {
  const client = await findClient(db, id);

  if (!client) {
    throw new SsoAdminError("No such application.");
  }

  return client;
};

/** The active applications with a console of their own that `userId` may sign in to, for the account menu's Apps. */
export const listApps = async (
  db: Database,
  userId: string
): Promise<{ id: string; name: string; launchUrl: string }[]> => {
  const [rows, memberships] = await Promise.all([
    db.query.oauthClients.findMany({
      where: eq(oauthClients.active, true),
      orderBy: [asc(oauthClients.name)],
    }),
    db.query.oauthClientMembers.findMany({
      columns: { clientId: true },
      where: eq(oauthClientMembers.userId, userId),
    }),
  ]);

  const listed = new Set(memberships.map((m) => m.clientId));

  return rows.flatMap((c) =>
    c.launchUrl && (c.access === "everyone" || listed.has(c.id))
      ? [{ id: c.id, name: c.name, launchUrl: c.launchUrl }]
      : []
  );
};

/** Whether `userId` may sign in to `client`, and the role its list gives them. */
export const clientAccessFor = async (
  db: Database,
  client: OauthClient,
  userId: string
): Promise<{ allowed: boolean; role: string | null }> => {
  const member = await db.query.oauthClientMembers.findFirst({
    where: and(
      eq(oauthClientMembers.clientId, client.id),
      eq(oauthClientMembers.userId, userId)
    ),
  });

  if (client.access === "everyone") {
    return { allowed: true, role: member?.role ?? null };
  }

  return member
    ? { allowed: true, role: member.role }
    : { allowed: false, role: null };
};

export const listClientMembers = (
  db: Database,
  clientId: string
): Promise<ClientMemberView[]> =>
  db
    .select({
      userId: oauthClientMembers.userId,
      role: oauthClientMembers.role,
      email: users.email,
      name: users.name,
      active: users.active,
    })
    .from(oauthClientMembers)
    .innerJoin(users, eq(users.id, oauthClientMembers.userId))
    .where(eq(oauthClientMembers.clientId, clientId))
    .orderBy(users.name);

/** Puts a person on an application's list, or changes their role there. */
export const setClientMember = async (
  db: Database,
  actor: User,
  clientId: string,
  userId: string,
  roleText: string | null | undefined
): Promise<void> => {
  await requireClient(db, clientId);

  const person = await db.query.users.findFirst({
    columns: { id: true },
    // A group inbox never signs in, so no application is ever its.
    where: and(eq(users.id, userId), eq(users.kind, "person")),
  });

  if (!person) {
    throw new SsoAdminError("No such person.");
  }

  const role = parseRole(roleText);

  await db
    .insert(oauthClientMembers)
    .values({ clientId, userId, role, createdBy: actor.id })
    .onConflictDoUpdate({
      target: [oauthClientMembers.clientId, oauthClientMembers.userId],
      set: { role },
    });
};

export const removeClientMember = async (
  db: Database,
  clientId: string,
  userId: string
): Promise<void> => {
  await db
    .delete(oauthClientMembers)
    .where(
      and(
        eq(oauthClientMembers.clientId, clientId),
        eq(oauthClientMembers.userId, userId)
      )
    );
};

export const redirectUriAllowed = (client: OauthClient, uri: string): boolean =>
  uris(client.redirectUrisJson).includes(uri);

export const postLogoutUriAllowed = (
  client: OauthClient,
  uri: string
): boolean => uris(client.postLogoutRedirectUrisJson).includes(uri);

const newSecret = (): string => `${SECRET_PREFIX}${randomToken(32)}`;

export const verifyClientSecret = async (
  client: OauthClient,
  secret: string
): Promise<boolean> =>
  Boolean(secret) &&
  constantTimeEqual(client.secretHash, await sha256Hex(secret));

const clientColumns = (input: SsoClientInput) => ({
  name: parseName(input.name),
  redirectUrisJson: JSON.stringify(parseUriList(input.redirectUris)),
  postLogoutRedirectUrisJson: JSON.stringify(
    parseUriList(input.postLogoutRedirectUris, { allowEmpty: true })
  ),
  launchUrl: parseLaunchUrl(input.launchUrl),
  pkceRequired: input.pkceRequired,
  access: input.access,
});

/** Registers an application; the secret is answered this once, for the admin to paste into the application. */
export const createClient = async (
  db: Database,
  actor: User,
  input: SsoClientInput
): Promise<{ client: SsoClientView; secret: string }> => {
  const secret = newSecret();
  const columns = clientColumns(input);

  const [row] = await db
    .insert(oauthClients)
    .values({
      id: newId("app"),
      secretHash: await sha256Hex(secret),
      createdBy: actor.id,
      ...columns,
    })
    .returning();

  if (!row) {
    throw new Error("The application was not registered.");
  }

  return { client: clientView(row), secret };
};

export const updateClient = async (
  db: Database,
  id: string,
  input: SsoClientInput
): Promise<void> => {
  await requireClient(db, id);
  await db
    .update(oauthClients)
    .set(clientColumns(input))
    .where(eq(oauthClients.id, id));
};

/** A new secret; the old one stops working at once. */
export const rotateClientSecret = async (
  db: Database,
  id: string
): Promise<string> => {
  await requireClient(db, id);

  const secret = newSecret();

  await db
    .update(oauthClients)
    .set({ secretHash: await sha256Hex(secret) })
    .where(eq(oauthClients.id, id));

  return secret;
};

/** A deactivated application cannot start a sign-in or redeem a code; its registration stays for when it returns. */
export const setClientActive = async (
  db: Database,
  id: string,
  active: boolean
): Promise<void> => {
  await requireClient(db, id);
  await db.update(oauthClients).set({ active }).where(eq(oauthClients.id, id));
};

/** The application a sign-in continues to, when `next` is one of its authorization requests: the sign-in page names it. */
export const applicationForNext = async (
  db: Database,
  next: string | undefined
): Promise<string | null> => {
  if (!next?.startsWith(`${SSO_PATHS.authorize}?`)) {
    return null;
  }

  const clientId =
    new URLSearchParams(next.slice(next.indexOf("?") + 1)).get("client_id") ??
    "";

  const client = await findClient(db, clientId);

  return client?.active ? client.name : null;
};
