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
 * Whether a token opens and what it reaches is the gate's (`openLink`, `reachAllByLink` in `access.server.ts`), and
 * what a visitor proves is `visitor.server.ts`'s: the lookup throttle, an invite's code and the pass, through
 * `linkVisits`. This module makes, lists and revokes links, mails invites, asks a link's password (throttled per
 * client and link), counts views and downloads, and answers the public page (`/s/$token`, its form posts) and its
 * file route (`/s/$token/file/$nodeId`).
 */
import { randomToken, sha256Hex } from "~/lib/crypto";
import { defined, formText } from "~/lib/guards";

import { hashPassword } from "../auth.server";
import { newId } from "../ids";
import { domainOf, isValidEmail } from "../mail/addresses";
import { openSecret, sealSecret } from "../secret-box.server";
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
import { mailOut } from "./mail-out.server";
import { fileResponse } from "./serve.server";
import {
  admit,
  failuresOf,
  passCookie as visitorPass,
  readPasses as visitorPasses,
  tooManyRequests,
  visitorPost,
} from "./visitor.server";
import type { Visits } from "./visitor.server";

/** Invites one person can send in an hour. */
const INVITES_PER_HOUR = 20;

/** Wrong passwords for one link from one client, in the 15 minutes `failuresOf` counts them. */
const PASSWORD_FAILURES = 10;

const SEAL_TOKEN = "drive-link";

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

/**
 * What a link brings to `visitor.server.ts`: an invite's code goes to its address, and a pass never outlives the
 * link's end.
 */
export const linkVisits: Visits<DriveLink> = {
  name: "drive-link",
  pass: { seal: "drive-link-pass", cookie: "drive_pass_", field: "l" },
  endsAt: (link) => (link.expiresAt ? Date.parse(link.expiresAt) : null),
  codeTo: (link) => (link.kind === "invite" ? link.email : null),
  codeOpens: (_link, env) => `what was shared with you on ${env.APP_NAME}`,
  confirmed: (link) => {
    log("drive.link.confirmed", { linkId: link.id });
  },
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

/* ---------- what a visitor proves ---------- */

/** The pass cookie for a link whose password was typed or whose code was confirmed: never past the link's end. */
export const passCookie = (
  request: Request,
  env: Env,
  link: DriveLink,
  at = Date.now()
): Promise<string> => visitorPass(request, env, linkVisits, link, at);

/** The links the request's pass cookies are good for. */
export const readPasses = (
  request: Request,
  env: Env,
  at = Date.now()
): Promise<Set<string>> => visitorPasses(request, env, linkVisits, at);

/** The gate for a request from outside the workspace (`openLink`), under the visitor's lookup throttle (`admit`). */
export const admitLink = (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  proof: LinkProof,
  at = Date.now()
): Promise<LinkAccess | null | "throttled"> =>
  admit(env, request, linkVisits, () => openLink(db, token, proof, at));

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
 * The forms of `/s/$token`, posted without JavaScript (`visitorPost`, which refuses a post from another site):
 * `password` (a link's password), `send-code` (mail an invite's code) and `code` (confirm it). Answers a redirect back
 * to the page, with the pass cookie once the password or the code was right, else an `error` (`password`, `code`,
 * `codes`, `throttled`) or the `step` to show.
 */
export const sharedPagePost = (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  form: FormData,
  at = Date.now()
): Promise<Response> =>
  visitorPost(
    env,
    db,
    request,
    linkVisits,
    {
      path: `/s/${token}`,
      keep: ["n"],
      form: () => Promise.resolve(form),
      own: async (posted, back) => {
        if (formText(posted, "intent") !== "password") {
          return null;
        }

        const hex = await sha256Hex(token);

        const failures = failuresOf(
          env,
          request,
          "drive-link:password",
          hex.slice(0, 32)
        );

        if (await failures.reached(PASSWORD_FAILURES)) {
          return back({ error: "throttled" });
        }

        const access = await admitLink(
          env,
          db,
          request,
          token,
          { password: formText(posted, "password") },
          at
        );

        if (access === "throttled") {
          return back({ error: "throttled" });
        }

        if (access?.state === "open") {
          return back({}, await passCookie(request, env, access.open.link, at));
        }

        if (access?.state === "password") {
          await failures.add();

          return back({ error: "password" });
        }

        return back();
      },
      // The invite the code's forms are for, whatever pass the visitor carries: one confirmed may ask for a new code.
      row: async () => {
        const access = await admitLink(env, db, request, token, {}, at);

        if (access === "throttled") {
          return access;
        }

        return access?.state === "invite" ? access.link : null;
      },
    },
    at
  );

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
    return tooManyRequests();
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
