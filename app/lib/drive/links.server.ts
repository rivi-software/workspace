import { sendMail } from "@rivi-software/workers-mail";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { driveLinks, driveNodes, users } from "~/db/schema";
import type { DriveLink, DriveNode } from "~/db/schema";
/**
 * Drive's folders and files shared outside the workspace (#2836). Anyone who reaches a node makes a link (whoever
 * holds it views, after its password when it has one) or an invite (one address, whose holder confirms with a code
 * mailed there): viewer only, ending `LINK_DEFAULT_DAYS` after it was made unless its creator chose another date or
 * none, revoked by its creator or the node's owner. An admin can turn all of it off (Settings → Drive): nothing new
 * is made and every link answers as if it did not exist, until it is on again.
 *
 * Whether a token opens and what it reaches is the gate's (`openLink`, `reachAllByLink` in `access.server.ts`). This
 * module makes, lists and revokes links, mails invites and their codes, keeps the pass a visitor carries once their
 * password or code was right, throttles the public paths, counts views and downloads, and answers the public page
 * (`/s/$token`, its form posts) and its file route (`/s/$token/file/$nodeId`).
 */
import { randomToken, sha256Hex } from "~/lib/crypto";
import { defined, numberOr, parseJsonObject, stringOrNull } from "~/lib/guards";

import { hashPassword, isSecure } from "../auth.server";
import { newId } from "../ids";
import { domainOf, isValidEmail } from "../mail/addresses";
import { openSecret, sealSecret } from "../secret-box.server";
import { textToHtml } from "../text";
import { externalSharingOn } from "../workspace-settings.server";
import {
  chunks,
  crumbsByLink,
  liveLink,
  openLink,
  reach,
  reachAllByLink,
  reachByLink,
  reachFileByLink,
} from "./access.server";
import type { LinkAccess, LinkProof } from "./access.server";
import {
  LINK_DEFAULT_DAYS,
  LINK_PASSWORD_MIN,
  LIST_LIMIT,
  compareRows,
  maskEmail,
  previewOf,
} from "./drive";
import type { DriveCrumb, SharedRow } from "./drive";
import { DriveError } from "./drive.server";
import { fileResponse } from "./serve.server";

/** A pass (a password typed, a code confirmed) lasts this long, and never past its link's end. */
const PASS_TTL_SECONDS = 24 * 60 * 60;

/** An invite's code works this long, for this many tries. */
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ATTEMPTS = 5;

/** Codes one invite can be sent in an hour, and invites one person can send in an hour. */
const CODES_PER_HOUR = 5;
const INVITES_PER_HOUR = 20;

/** Tokens that open nothing, from one client in `THROTTLE_SECONDS`, before it is refused outright. */
const LOOKUP_MISSES = 30;

/** Wrong passwords for one link from one client in `THROTTLE_SECONDS`. */
const PASSWORD_FAILURES = 10;
const THROTTLE_SECONDS = 15 * 60;

const SEAL_TOKEN = "drive-link";
const SEAL_PASS = "drive-link-pass";
const PASS_COOKIE = "drive_pass_";

const longDate = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeZone: "UTC",
});

/** The address of a link's page: what is copied and mailed. */
export const linkUrl = (env: Env, token: string): string =>
  `${env.APP_URL.replace(/\/+$/u, "")}/s/${token}`;

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- log fields are free-form key/value pairs the line carries as JSON
const log = (event: string, fields: Record<string, unknown>) => {
  console.log(JSON.stringify({ event, ...fields }));
};

/* ---------- making, listing and revoking ---------- */

export interface NewExternalShare {
  kind: "link" | "invite";
  /** An invite's address. */
  email?: string;
  /** A link's password; none when empty. */
  password?: string;
  allowDownload: boolean;
  /** When it ends: an ISO time, null for never, undefined for `LINK_DEFAULT_DAYS` from now. */
  expiresAt?: string | null;
}

/**
 * From `no-reply@` on the mail domain, as the recovery mail: the domain is onboarded in SES and Email Service. Drive's
 * signing mails its codes and notices with it too.
 */
export const mailOut = async (
  env: Env,
  to: string,
  name: string,
  subject: string,
  text: string
) => {
  await sendMail(env, {
    from: { email: `no-reply@${env.MAIL_DOMAIN}`, name },
    to,
    subject,
    text,
    html: textToHtml(text),
  });
};

const mailInvite = async (
  env: Env,
  input: {
    to: string;
    from: string;
    node: DriveNode;
    url: string;
    expiresAt: string | null;
  }
) => {
  const what = input.node.kind === "folder" ? "folder" : "file";
  await mailOut(
    env,
    input.to,
    `${input.from} (${env.APP_NAME})`,
    `${input.from} shared "${input.node.name}" with you`,
    [
      `${input.from} shared the ${what} "${input.node.name}" with you, to view${input.node.kind === "folder" ? " and download what is in it" : ""}.`,
      `Open it:\n${input.url}`,
      `When you open it, we mail a code to this address to confirm it is you. ${
        input.expiresAt
          ? `The invitation works until ${longDate.format(new Date(input.expiresAt))}.`
          : "The invitation has no end date."
      }`,
      "If you did not expect this mail, you can ignore it.",
    ].join("\n\n")
  );
};

/**
 * A link or an invite on a node the person reaches (any role: a link only ever views). An invite is mailed to its
 * address at once; when the mail fails, the invite is taken back.
 */
export const createExternalShare = async (
  env: Env,
  db: Database,
  user: { id: string; name: string },
  nodeId: string,
  input: NewExternalShare,
  at = Date.now()
): Promise<{ link: DriveLink; url: string }> => {
  if (!(await externalSharingOn(db))) {
    throw new DriveError("An admin turned off sharing outside the workspace.");
  }

  const reached = await reach(db, user.id, nodeId, "outside");

  if (!reached) {
    throw new DriveError("That is gone.");
  }

  const { node } = reached;

  const expiresAt =
    input.expiresAt === undefined
      ? new Date(at + LINK_DEFAULT_DAYS * 86_400_000).toISOString()
      : input.expiresAt;

  if (expiresAt !== null && !(Date.parse(expiresAt) > at)) {
    throw new DriveError("Choose an end date in the future, or none.");
  }

  let email: string | null = null;
  let passwordHash: string | null = null;

  if (input.kind === "invite") {
    email = (input.email ?? "").trim().toLowerCase();

    if (!isValidEmail(email)) {
      throw new DriveError(`"${input.email ?? ""}" is not a valid address.`);
    }

    if (domainOf(email) === env.MAIL_DOMAIN.toLowerCase()) {
      throw new DriveError(
        `${email} is in the workspace: share it with them inside the workspace instead.`
      );
    }

    // Every invite to the address that was never revoked: an expired one is never revoked, and may come first.
    const invited = await db
      .select({ expiresAt: driveLinks.expiresAt })
      .from(driveLinks)
      .where(
        and(
          eq(driveLinks.nodeId, node.id),
          eq(driveLinks.kind, "invite"),
          eq(driveLinks.email, email),
          isNull(driveLinks.revokedAt)
        )
      );

    if (
      invited.some((r) =>
        liveLink({ revokedAt: null, expiresAt: r.expiresAt }, at)
      )
    ) {
      throw new DriveError(`${email} is invited already.`);
    }

    const [sent] = await db
      .select({ n: count() })
      .from(driveLinks)
      .where(
        and(
          eq(driveLinks.createdBy, user.id),
          eq(driveLinks.kind, "invite"),
          gt(driveLinks.createdAt, new Date(at - 3_600_000).toISOString())
        )
      );

    if ((sent?.n ?? 0) >= INVITES_PER_HOUR) {
      throw new DriveError(
        "Too many invitations in the last hour. Wait a while, then invite again."
      );
    }
  } else if (input.password) {
    if (input.password.length < LINK_PASSWORD_MIN) {
      throw new DriveError(
        `A link's password has at least ${LINK_PASSWORD_MIN} characters.`
      );
    }

    passwordHash = await hashPassword(input.password);
  }

  const token = randomToken(32);
  const id = newId("dl");
  await db.insert(driveLinks).values({
    id,
    nodeId: node.id,
    kind: input.kind,
    tokenHash: await sha256Hex(token),
    tokenSealed: await sealSecret(env, SEAL_TOKEN, token),
    email,
    passwordHash,
    allowDownload: input.allowDownload,
    expiresAt,
    createdBy: user.id,
    createdAt: new Date(at).toISOString(),
  });
  const url = linkUrl(env, token);

  if (email) {
    try {
      await mailInvite(env, {
        to: email,
        from: user.name,
        node,
        url,
        expiresAt,
      });
    } catch (error) {
      await db.delete(driveLinks).where(eq(driveLinks.id, id));
      // SAFETY: `mailInvite` fails with an Error from the mail client, whose optional `code` is a string or number; only `code` and `message` are read.
      const e = error as Error & { code?: string | number };
      throw new DriveError(
        `The invitation to ${email} was not sent: ${[e.code, e.message].filter(Boolean).join(" ")}.`
      );
    }
  }

  log("drive.link.created", {
    linkId: id,
    nodeId: node.id,
    kind: input.kind,
    by: user.id,
  });

  const link = defined(
    await db.query.driveLinks.findFirst({
      where: eq(driveLinks.id, id),
    }),
    "the result of find first"
  );

  return { link, url };
};

/** A link or invite as the share dialog shows it to someone who reaches its node. */
export interface ExternalShareView {
  id: string;
  kind: "link" | "invite";
  email: string | null;
  /** The address to copy: for its creator and the node's owner only. */
  url: string | null;
  password: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string };
  mine: boolean;
  canRevoke: boolean;
  live: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  confirmedAt: string | null;
  views: number;
  downloads: number;
  lastViewedAt: string | null;
}

export interface ExternalSharing {
  /** Whether the person owns the node: they share it inside the workspace too, and revoke anyone's link on it. */
  owner: boolean;
  /** Whether sharing outside the workspace is on (Settings → Drive). */
  enabled: boolean;
  /** Whether the person may make a link here now: it is on, and the node is out of the trash. */
  canCreate: boolean;
  /** The node's links and invites, newest first, the ended ones too (at most 50). */
  links: ExternalShareView[];
}

const namesOf = async (
  db: Database,
  ids: (string | null)[]
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];

  for (const slice of chunks(wanted)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- run in turn: the lists are short and their order is kept
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, slice));

    for (const r of rows) {
      out.set(r.id, r.name);
    }
  }

  return out;
};

/** The links and invites on a node the person reaches (the owner: their trashed node too). */
export const listExternalShares = async (
  env: Env,
  db: Database,
  userId: string,
  nodeId: string,
  at = Date.now()
): Promise<ExternalSharing> => {
  const reached = await reach(db, userId, nodeId, "own-trash");

  if (!reached) {
    throw new DriveError("That is gone.");
  }

  const owner = reached.role === "owner";
  const enabled = await externalSharingOn(db);

  const rows = await db.query.driveLinks.findMany({
    where: eq(driveLinks.nodeId, reached.node.id),
    orderBy: [desc(driveLinks.createdAt)],
    limit: 50,
  });

  const names = await namesOf(
    db,
    rows.flatMap((r) => [r.createdBy, r.revokedBy])
  );

  const links: ExternalShareView[] = [];

  for (const r of rows) {
    const mine = r.createdBy === userId;
    const live = liveLink(r, at);

    const token =
      live && (mine || owner)
        ? // oxlint-disable-next-line eslint/no-await-in-loop -- run in turn: the lists are short and their order is kept
          await openSecret(env, SEAL_TOKEN, r.tokenSealed)
        : null;

    links.push({
      id: r.id,
      kind: r.kind,
      email: r.email,
      url: token ? linkUrl(env, token) : null,
      password: !!r.passwordHash,
      allowDownload: r.allowDownload,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      createdBy: { id: r.createdBy, name: names.get(r.createdBy) ?? "Someone" },
      mine,
      canRevoke: live && (mine || owner),
      live,
      revokedAt: r.revokedAt,
      revokedBy: r.revokedBy ? (names.get(r.revokedBy) ?? "Someone") : null,
      confirmedAt: r.confirmedAt,
      views: r.views,
      downloads: r.downloads,
      lastViewedAt: r.lastViewedAt,
    });
  }

  return {
    owner,
    enabled,
    canCreate: enabled && !reached.node.trashedAt,
    links,
  };
};

/** Revoke a live link or invite: its creator, or the owner of its node. It stops at once and stays on record. */
export const revokeExternalShare = async (
  db: Database,
  userId: string,
  linkId: string,
  at = Date.now()
): Promise<DriveLink> => {
  const link = await db.query.driveLinks.findFirst({
    where: eq(driveLinks.id, linkId),
  });

  if (!link || !liveLink(link, at)) {
    throw new DriveError("That link has ended already.");
  }

  if (link.createdBy !== userId) {
    const reached = await reach(db, userId, link.nodeId, "own-trash");

    if (reached?.role !== "owner") {
      throw new DriveError("Only who made it and the owner can stop a link.");
    }
  }

  const now = new Date(at).toISOString();
  await db
    .update(driveLinks)
    .set({
      revokedAt: now,
      revokedBy: userId,
      codeHash: null,
      codeExpiresAt: null,
    })
    .where(and(eq(driveLinks.id, link.id), isNull(driveLinks.revokedAt)));
  log("drive.link.revoked", {
    linkId: link.id,
    nodeId: link.nodeId,
    by: userId,
  });

  return { ...link, revokedAt: now, revokedBy: userId };
};

/** A link or invite as Settings → Drive lists it for an admin: what, who made it, who ended it, how much it was used. */
export interface ExternalShareRecord {
  id: string;
  kind: "link" | "invite";
  email: string | null;
  node: { id: string; name: string; kind: "folder" | "file" };
  createdBy: { name: string; email: string };
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  live: boolean;
  password: boolean;
  allowDownload: boolean;
  views: number;
  downloads: number;
  lastViewedAt: string | null;
}

/** Every link and invite in the workspace, newest first: the record of what was shared outside, for an admin. */
export const externalShareRecords = async (
  db: Database,
  limit = 100,
  at = Date.now()
): Promise<ExternalShareRecord[]> => {
  const rows = await db
    .select({
      link: driveLinks,
      nodeName: driveNodes.name,
      nodeKind: driveNodes.kind,
      creatorName: users.name,
      creatorEmail: users.email,
    })
    .from(driveLinks)
    .innerJoin(driveNodes, eq(driveNodes.id, driveLinks.nodeId))
    .innerJoin(users, eq(users.id, driveLinks.createdBy))
    .orderBy(desc(driveLinks.createdAt))
    .limit(limit);

  const names = await namesOf(
    db,
    rows.map((r) => r.link.revokedBy)
  );

  return rows.map(({ link: l, ...r }) => ({
    id: l.id,
    kind: l.kind,
    email: l.email,
    node: { id: l.nodeId, name: r.nodeName, kind: r.nodeKind },
    createdBy: { name: r.creatorName, email: r.creatorEmail },
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    revokedAt: l.revokedAt,
    revokedBy: l.revokedBy ? (names.get(l.revokedBy) ?? "Someone") : null,
    live: liveLink(l, at),
    password: !!l.passwordHash,
    allowDownload: l.allowDownload,
    views: l.views,
    downloads: l.downloads,
    lastViewedAt: l.lastViewedAt,
  }));
};

/* ---------- mail ---------- */

/* ---------- an invite's code ---------- */

const codeHashOf = async (link: DriveLink, code: string) =>
  await sha256Hex(`${link.id}:${code}`);

/**
 * A new one-time code for an invite, mailed to its address: six digits, `CODE_TTL_MS`, `CODE_ATTEMPTS` tries. False
 * when the invite had `CODES_PER_HOUR` codes in the last hour already.
 */
export const sendInviteCode = async (
  env: Env,
  db: Database,
  link: DriveLink,
  at = Date.now()
): Promise<boolean> => {
  if (link.kind !== "invite" || !link.email) {
    return false;
  }

  const key = `drive-link:codes:${link.id}`;
  const sent = Number((await env.KV.get(key)) ?? 0);

  if (sent >= CODES_PER_HOUR) {
    return false;
  }

  await env.KV.put(key, String(sent + 1), { expirationTtl: 3600 });

  const code = String(
    defined(crypto.getRandomValues(new Uint32Array(1))[0], "the first item") %
      1_000_000
  ).padStart(6, "0");

  await db
    .update(driveLinks)
    .set({
      codeHash: await codeHashOf(link, code),
      codeExpiresAt: new Date(at + CODE_TTL_MS).toISOString(),
      codeAttempts: 0,
    })
    .where(eq(driveLinks.id, link.id));
  await mailOut(
    env,
    link.email,
    env.APP_NAME,
    `Your code: ${code}`,
    [
      `Your code to open what was shared with you on ${env.APP_NAME}: ${code}`,
      "It works once, for 10 minutes. If you did not ask for it, you can ignore this mail.",
    ].join("\n\n")
  );

  return true;
};

/**
 * Whether `typed` is the invite's live code. A wrong one counts against it, and the right one is spent: of two
 * requests with it, one wins.
 */
export const confirmInviteCode = async (
  db: Database,
  link: DriveLink,
  typed: string,
  at = Date.now()
): Promise<boolean> => {
  const code = typed.replaceAll(/\D/gu, "");

  if (
    !link.codeHash ||
    !link.codeExpiresAt ||
    Date.parse(link.codeExpiresAt) <= at
  ) {
    return false;
  }

  // The try is taken before comparing, in one statement on the row: parallel guesses that all read the same
  // `code_attempts` from `link` still get `CODE_ATTEMPTS` tries between them, not each.
  const [tried] = await db
    .update(driveLinks)
    .set({ codeAttempts: sql`${driveLinks.codeAttempts} + 1` })
    .where(
      and(
        eq(driveLinks.id, link.id),
        eq(driveLinks.codeHash, link.codeHash),
        sql`${driveLinks.codeAttempts} < ${CODE_ATTEMPTS}`
      )
    )
    .returning({ id: driveLinks.id });

  if (!tried) {
    return false;
  }

  if (code.length !== 6 || (await codeHashOf(link, code)) !== link.codeHash) {
    return false;
  }

  const [spent] = await db
    .update(driveLinks)
    .set({
      codeHash: null,
      codeExpiresAt: null,
      codeAttempts: 0,
      confirmedAt: link.confirmedAt ?? new Date(at).toISOString(),
    })
    .where(
      and(eq(driveLinks.id, link.id), eq(driveLinks.codeHash, link.codeHash))
    )
    .returning({ id: driveLinks.id });

  if (spent) {
    log("drive.link.confirmed", { linkId: link.id });
  }

  return !!spent;
};

/* ---------- the pass a visitor carries ---------- */

/**
 * The cookie that lets a visitor back in without the password or a code: sealed, naming its link, until
 * `PASS_TTL_SECONDS` or the link's end, sent only under `/s/`. The gate still decides on every request.
 */
export const passCookie = async (
  request: Request,
  env: Env,
  link: DriveLink,
  at = Date.now()
): Promise<string> => {
  const end = Math.min(
    at + PASS_TTL_SECONDS * 1000,
    link.expiresAt ? Date.parse(link.expiresAt) : Infinity
  );

  const value = await sealSecret(
    env,
    SEAL_PASS,
    JSON.stringify({ l: link.id, exp: end })
  );

  const maxAge = Math.max(0, Math.floor((end - at) / 1000));

  return `${PASS_COOKIE}${link.id}=${value}; Path=/s/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isSecure(request) ? "; Secure" : ""}`;
};

/** The links the request's pass cookies are good for: sealed by us, for that link, not past their end. */
export const readPasses = async (
  request: Request,
  env: Env,
  at = Date.now()
): Promise<Set<string>> => {
  const out = new Set<string>();
  const header = request.headers.get("cookie") ?? "";

  for (const part of header.split(";").slice(0, 50)) {
    const [name, ...rest] = part.trim().split("=");

    if (!name?.startsWith(PASS_COOKIE)) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- run in turn: the lists are short and their order is kept
    const opened = await openSecret(env, SEAL_PASS, rest.join("="));

    if (!opened) {
      continue;
    }

    // A cookie that does not open to a pass of ours reads as an empty one, and is skipped.
    const pass = parseJsonObject(opened);
    const passLink = stringOrNull(pass.l);

    if (
      passLink !== null &&
      name === `${PASS_COOKIE}${passLink}` &&
      numberOr(pass.exp, Number.NEGATIVE_INFINITY) > at
    ) {
      out.add(passLink);
    }
  }

  return out;
};

/* ---------- throttles ---------- */

const clientOf = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? "unknown";

const counted = async (kv: KVNamespace, key: string): Promise<number> =>
  Number((await kv.get(key)) ?? 0);

const bump = async (kv: KVNamespace, key: string): Promise<void> => {
  await kv.put(key, String((await counted(kv, key)) + 1), {
    expirationTtl: THROTTLE_SECONDS,
  });
};

/**
 * The gate for a request from outside the workspace, throttled: a client whose tokens opened nothing
 * `LOOKUP_MISSES` times in `THROTTLE_SECONDS` is refused before any lookup. KV is eventually consistent, which is
 * fine for a brake: a token is 32 random bytes, not something to guess.
 */
export const admitLink = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  proof: LinkProof,
  at = Date.now()
): Promise<LinkAccess | null | "throttled"> => {
  const missKey = `drive-link:miss:${clientOf(request)}`;

  if ((await counted(env.KV, missKey)) >= LOOKUP_MISSES) {
    return "throttled";
  }

  const access = await openLink(db, token, proof, at);

  if (!access) {
    await bump(env.KV, missKey);
  }

  return access;
};

/* ---------- the public page ---------- */

/** What `/s/$token` shows: the node a link opened, or what it asks first. */
export type SharedPage =
  | { state: "throttled" }
  | { state: "password" }
  | { state: "invite"; email: string }
  | {
      state: "open";
      appName: string;
      /** Who shared it: their name, never their address. */
      sharedBy: string;
      expiresAt: string | null;
      allowDownload: boolean;
      root: { id: string; name: string };
      /** The folders from the shared one down to the node's own, the shared one first; empty at it. */
      crumbs: DriveCrumb[];
      node: SharedRow;
      /** A folder's contents, folders first. */
      rows: SharedRow[];
    };

const sharedRow = (n: DriveNode): SharedRow => ({
  id: n.id,
  kind: n.kind,
  name: n.name,
  contentType: n.contentType,
  size: n.size,
  updatedAt: n.updatedAt,
});

/**
 * The page of a token, at the node it shares or `nodeId` under it; null when the link is no good or does not reach
 * that node (404). Each page opened through it counts as a view.
 */
export const sharedPage = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  nodeId: string | null,
  at = Date.now()
): Promise<SharedPage | null> => {
  const access = await admitLink(
    env,
    db,
    request,
    token,
    { passes: await readPasses(request, env, at) },
    at
  );

  if (access === "throttled") {
    return { state: "throttled" };
  }

  if (!access) {
    return null;
  }

  if (access.state === "password") {
    return { state: "password" };
  }

  if (access.state === "invite") {
    return { state: "invite", email: maskEmail(access.link.email ?? "") };
  }

  const { open } = access;

  const shown = nodeId
    ? await reachByLink(db, open, nodeId)
    : { node: open.root };

  if (!shown) {
    return null;
  }

  const { node } = shown;
  let rows: SharedRow[] = [];

  if (node.kind === "folder") {
    const children = await db.query.driveNodes.findMany({
      where: and(
        eq(driveNodes.parentId, node.id),
        isNull(driveNodes.trashedAt)
      ),
      limit: LIST_LIMIT,
    });

    const reached = await reachAllByLink(db, open, children);

    rows = reached
      .map((r) => sharedRow(r.node))
      .toSorted(compareRows("name", "asc"));
  }

  await db
    .update(driveLinks)
    .set({
      views: sql`${driveLinks.views} + 1`,
      lastViewedAt: new Date(at).toISOString(),
    })
    .where(eq(driveLinks.id, open.link.id));

  return {
    state: "open",
    appName: env.APP_NAME,
    sharedBy: open.creator.name,
    expiresAt: open.link.expiresAt,
    allowDownload: open.link.allowDownload,
    root: { id: open.root.id, name: open.root.name },
    crumbs: await crumbsByLink(db, open, node),
    node: sharedRow(node),
    rows,
  };
};

/**
 * The forms of `/s/$token`, posted without JavaScript: `password` (a link's password), `send-code` (mail an invite's
 * code) and `code` (confirm it). Answers a redirect back to the page, with the pass cookie once the password or the
 * code was right, else an `error` (`password`, `code`, `codes`, `throttled`) or the `step` to show.
 */
export const sharedPagePost = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  form: FormData,
  at = Date.now()
): Promise<Response> => {
  const url = new URL(request.url);

  const back = (params: Record<string, string> = {}, cookie?: string) => {
    const next = new URLSearchParams();
    const n = url.searchParams.get("n");

    if (n) {
      next.set("n", n);
    }

    for (const [k, v] of Object.entries(params)) {
      next.set(k, v);
    }

    const query = next.toString();

    const headers = new Headers({
      Location: `/s/${token}${query ? `?${query}` : ""}`,
    });

    if (cookie) {
      headers.append("Set-Cookie", cookie);
    }

    return new Response(null, { status: 303, headers });
  };

  const intent = String(form.get("intent") ?? "");
  const client = clientOf(request);

  if (intent === "password") {
    const hex = await sha256Hex(token);
    const failKey = `drive-link:password:${client}:${hex.slice(0, 32)}`;

    if ((await counted(env.KV, failKey)) >= PASSWORD_FAILURES) {
      return back({ error: "throttled" });
    }

    const access = await admitLink(
      env,
      db,
      request,
      token,
      { password: String(form.get("password") ?? "") },
      at
    );

    if (access === "throttled") {
      return back({ error: "throttled" });
    }

    if (access?.state === "open") {
      return back({}, await passCookie(request, env, access.open.link, at));
    }

    if (access?.state === "password") {
      await bump(env.KV, failKey);

      return back({ error: "password" });
    }

    return back();
  }

  const access = await admitLink(env, db, request, token, {}, at);

  if (access === "throttled") {
    return back({ error: "throttled" });
  }

  if (access?.state !== "invite") {
    return back();
  }

  if (intent === "send-code") {
    return (await sendInviteCode(env, db, access.link, at))
      ? back({ step: "code" })
      : back({ step: "code", error: "codes" });
  }

  if (intent === "code") {
    if (
      await confirmInviteCode(
        db,
        access.link,
        String(form.get("code") ?? ""),
        at
      )
    ) {
      return back({}, await passCookie(request, env, access.link, at));
    }

    return back({ step: "code", error: "code" });
  }

  return back();
};

/* ---------- the public file route ---------- */

const missing = () =>
  new Response("not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

/**
 * A file's bytes through a link (`/s/$token/file/$nodeId`), as the session's file route serves them (`fileResponse`:
 * the sandbox CSP, the attachment, Range), never cached past a revocation, without a referrer and kept out of search
 * engines. A link that does not allow downloads serves only what the page previews, inline. A download counts.
 */
export const sharedFileResponse = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  nodeId: string,
  at = Date.now()
): Promise<Response> => {
  const access = await admitLink(
    env,
    db,
    request,
    token,
    { passes: await readPasses(request, env, at) },
    at
  );

  if (access === "throttled") {
    return new Response("too many requests", {
      status: 429,
      headers: {
        "Retry-After": String(THROTTLE_SECONDS),
        "Cache-Control": "no-store",
      },
    });
  }

  if (access?.state !== "open") {
    return missing();
  }

  const file = await reachFileByLink(db, access.open, nodeId);

  if (!file) {
    return missing();
  }

  const { link } = access.open;
  const download = new URL(request.url).searchParams.get("download") === "1";

  if (
    !link.allowDownload &&
    (download || !previewOf(file.node.contentType, file.node.name))
  ) {
    return missing();
  }

  const res = await fileResponse(request, env.DRIVE, file, {
    download,
    inline: !link.allowDownload,
    cacheControl: "private, no-cache",
    headers: {
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });

  if (!res) {
    return missing();
  }

  if (download && res.status === 200) {
    await db
      .update(driveLinks)
      .set({ downloads: sql`${driveLinks.downloads} + 1` })
      .where(eq(driveLinks.id, link.id));
  }

  return res;
};
