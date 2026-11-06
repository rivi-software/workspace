import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Database } from "~/db";
import {
  driveLinks,
  driveNodes,
  driveShares,
  driveStars,
  users,
} from "~/db/schema";
import type { DriveLink, DriveNode } from "~/db/schema";
/**
 * Drive's one gate: who may reach which node. A person reaches a node they own, or one shared with them (with them or
 * with everyone) on itself or on a folder above it, the strongest of those roles counting. A trashed folder hides
 * everything under it, and which part of the trash a caller looks at is its `TrashPolicy`. A file still uploading is
 * nobody's to list or open: only its uploader reaches it, through `runningUpload`.
 *
 * Listings, views, search, the move picker, breadcrumbs, the actions, the file route and the Assistant find their
 * candidates (a folder's children, the nodes shared with the person, a name search) and keep what `reachAll`,
 * `reach` or `reachFile` answers; none of them reads `drive_shares` or decides on the trash itself.
 *
 * Someone outside the workspace comes in by a link's token instead (#2836): `openLink` decides whether the link
 * opens, and `reachAllByLink`, `reachByLink` and `reachFileByLink` keep what it reaches, viewer only, under `outside`:
 * what the link's creator still reaches, at or under the node it shares. The public page and its file route read
 * nothing else.
 */
import { sha256Hex } from "~/lib/crypto";
import { defined } from "~/lib/guards";

import { verifyPassword } from "../auth.server";
import { externalSharingOn } from "../workspace-settings.server";
import { EVERYONE, LIST_LIMIT, ancestorIds, subtreePrefix } from "./drive";
import type { DriveCrumb, DriveRole } from "./drive";

/**
 * Which part of the trash a caller looks at:
 * - `outside`: the node and every folder above it are out of the trash (listings, views, search, actions, the move
 *   picker, the Assistant);
 * - `own-trash`: that, and also each of the person's own trashed nodes, even one under a trashed folder (the file page
 *   and the file route, so the owner previews what they trashed; restoring and deleting for good). A node that is not
 *   trashed itself but sits under a trashed folder stays out;
 * - `trash-view`: only the person's own trashed nodes that no trashed folder hides, the tops of the trashed subtrees
 *   (the Trash view).
 */
export type TrashPolicy = "outside" | "own-trash" | "trash-view";

export interface Reached {
  node: DriveNode;
  role: DriveRole;
  /** Whether the person starred it. */
  starred: boolean;
  /** Whether its owner shared it with anyone (the marker on the owner's own rows). */
  shared: boolean;
  /** Whether a live link or invite shares it outside the workspace (the marker on everyone's rows). */
  linked: boolean;
  owner: { id: string; name: string };
}

/** A file the person may read: reached, and its bytes whole in the DRIVE bucket under `key`. */
export type ReadableFile = Reached & { key: string };

/** D1 binds at most 100 values a query; Drive's id lists go in slices of this many. */
const CHUNK = 90;

export const chunks = <T>(items: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
};

const roleRank: Record<DriveRole, number> = { viewer: 1, editor: 2, owner: 3 };

const best = (a: DriveRole | null, b: DriveRole | null): DriveRole | null => {
  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  return roleRank[a] >= roleRank[b] ? a : b;
};

const getNode = async (db: Database, id: string): Promise<DriveNode | null> =>
  (await db.query.driveNodes.findFirst({ where: eq(driveNodes.id, id) })) ??
  null;

const nodesById = async (
  db: Database,
  ids: string[]
): Promise<Map<string, DriveNode>> => {
  const out = new Map<string, DriveNode>();

  for (const slice of chunks([...new Set(ids)])) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk of ids per query to stay under D1's bound-variable limit; the chunks run in turn
    const rows = await db.query.driveNodes.findMany({
      where: inArray(driveNodes.id, slice),
    });

    for (const r of rows) {
      out.set(r.id, r);
    }
  }

  return out;
};

/** The shares on some nodes: the strongest role each gives the person, and which of them are shared at all. */
const sharesOn = async (
  db: Database,
  userId: string,
  ids: string[]
): Promise<{ held: Map<string, DriveRole>; shared: Set<string> }> => {
  const held = new Map<string, DriveRole>();
  const shared = new Set<string>();

  for (const slice of chunks([...new Set(ids)])) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk of ids per query to stay under D1's bound-variable limit; the chunks run in turn
    const rows = await db
      .select({
        nodeId: driveShares.nodeId,
        subject: driveShares.subject,
        role: driveShares.role,
      })
      .from(driveShares)
      .where(inArray(driveShares.nodeId, slice));

    for (const r of rows) {
      shared.add(r.nodeId);

      if (r.subject === userId || r.subject === EVERYONE) {
        held.set(
          r.nodeId,
          defined(
            best(held.get(r.nodeId) ?? null, r.role),
            "the result of best"
          )
        );
      }
    }
  }

  return { held, shared };
};

type Facts = Omit<Reached, "node" | "role"> & {
  /** The person's role on the node, or null when it is not theirs and not shared with them. */
  role: DriveRole | null;
  /** Whether a trashed folder above it hides it. */
  hidden: boolean;
};

/** Which of the nodes a live link or invite shares outside the workspace; none while an admin has it turned off. */
const liveLinksOn = async (
  db: Database,
  ids: string[],
  at = Date.now()
): Promise<Set<string>> => {
  const out = new Set<string>();
  const now = new Date(at).toISOString();

  for (const slice of chunks([...new Set(ids)])) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk of ids per query to stay under D1's bound-variable limit; the chunks run in turn
    const rows = await db
      .select({ nodeId: driveLinks.nodeId })
      .from(driveLinks)
      .where(
        and(
          inArray(driveLinks.nodeId, slice),
          isNull(driveLinks.revokedAt),
          or(isNull(driveLinks.expiresAt), gt(driveLinks.expiresAt, now))
        )
      );

    for (const r of rows) {
      out.add(r.nodeId);
    }
  }

  if (out.size && !(await externalSharingOn(db))) {
    return new Set();
  }

  return out;
};

/** For a batch of nodes at once, in a few queries: the person's role, the trashed folders above, stars and owners. */
const factsOf = async (
  db: Database,
  userId: string,
  nodes: DriveNode[]
): Promise<Map<string, Facts>> => {
  const out = new Map<string, Facts>();

  if (!nodes.length) {
    return out;
  }

  const ids = nodes.map((n) => n.id);
  const ancestors = new Set<string>();

  for (const n of nodes) {
    for (const a of ancestorIds(n.path)) {
      ancestors.add(a);
    }
  }

  const trashed = new Set<string>();

  for (const slice of chunks([...ancestors])) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk of ids per query to stay under D1's bound-variable limit; the chunks run in turn
    const rows = await db
      .select({ id: driveNodes.id })
      .from(driveNodes)
      .where(
        and(inArray(driveNodes.id, slice), isNotNull(driveNodes.trashedAt))
      );

    for (const r of rows) {
      trashed.add(r.id);
    }
  }

  const { held, shared } = await sharesOn(db, userId, [...ids, ...ancestors]);
  const stars = new Set<string>();

  for (const slice of chunks(ids)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk of ids per query to stay under D1's bound-variable limit; the chunks run in turn
    const rows = await db
      .select({ nodeId: driveStars.nodeId })
      .from(driveStars)
      .where(
        and(eq(driveStars.userId, userId), inArray(driveStars.nodeId, slice))
      );

    for (const r of rows) {
      stars.add(r.nodeId);
    }
  }

  const linked = await liveLinksOn(db, ids);
  const owners = new Map<string, string>();

  for (const slice of chunks([...new Set(nodes.map((n) => n.userId))])) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk of ids per query to stay under D1's bound-variable limit; the chunks run in turn
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, slice));

    for (const r of rows) {
      owners.set(r.id, r.name);
    }
  }

  for (const n of nodes) {
    let role: DriveRole | null = n.userId === userId ? "owner" : null;

    if (!role) {
      for (const id of [n.id, ...ancestorIds(n.path)]) {
        role = best(role, held.get(id) ?? null);
      }
    }

    out.set(n.id, {
      role,
      hidden: ancestorIds(n.path).some((a) => trashed.has(a)),
      starred: stars.has(n.id),
      shared: shared.has(n.id),
      linked: linked.has(n.id),
      owner: { id: n.userId, name: owners.get(n.userId) ?? "Someone" },
    });
  }

  return out;
};

const admits = (trash: TrashPolicy, node: DriveNode, f: Facts): boolean => {
  const live = !node.trashedAt && !f.hidden;
  const owned = f.role === "owner" && !!node.trashedAt;

  if (trash === "outside") {
    return live;
  }

  if (trash === "own-trash") {
    return live || owned;
  }

  return owned && !f.hidden;
};

/** Whether a candidate is an id still to load, not a node already read. */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- a candidate is a node or its id; the two are told apart at runtime
const isId = (candidate: DriveNode | string): candidate is string =>
  typeof candidate === "string";

/**
 * The candidates the person reaches under `trash`, in the order given, each once, with their role on it. A candidate
 * is a node already read or its id. A file still uploading is never among them.
 */
export const reachAll = async (
  db: Database,
  userId: string,
  candidates: readonly (DriveNode | string)[],
  trash: TrashPolicy
): Promise<Reached[]> => {
  const given = new Map<string, DriveNode>();
  const ids: string[] = [];

  for (const c of candidates) {
    if (isId(c)) {
      ids.push(c);
    } else {
      given.set(c.id, c);
    }
  }

  const loaded = ids.length
    ? await nodesById(db, ids)
    : new Map<string, DriveNode>();

  const order = [...new Set(candidates.map((c) => (isId(c) ? c : c.id)))];

  const nodes = order.flatMap((id) => {
    const node = given.get(id) ?? loaded.get(id);

    return node ? [node] : [];
  });

  const facts = await factsOf(db, userId, nodes);
  const out: Reached[] = [];

  for (const node of nodes) {
    const f = defined(facts.get(node.id), "the entry");

    if (!f.role || node.status !== "ready" || !admits(trash, node, f)) {
      continue;
    }

    out.push({
      node,
      role: f.role,
      starred: f.starred,
      shared: f.shared,
      linked: f.linked,
      owner: f.owner,
    });
  }

  return out;
};

/** One node the person reaches under `trash`, or null. */
export const reach = async (
  db: Database,
  userId: string,
  id: string,
  trash: TrashPolicy
): Promise<Reached | null> => {
  const node = await getNode(db, id);

  if (!node) {
    return null;
  }

  const reachable = await reachAll(db, userId, [node], trash);

  return reachable[0] ?? null;
};

/** A file the person may read under `trash`: reached, a file and not a folder, its bytes in the bucket. */
export const reachFile = async (
  db: Database,
  userId: string,
  id: string,
  trash: TrashPolicy
): Promise<ReadableFile | null> => {
  const reached = await reach(db, userId, id, trash);

  if (!reached || reached.node.kind !== "file" || !reached.node.r2Key) {
    return null;
  }

  return { ...reached, key: reached.node.r2Key };
};

/**
 * A file this person started uploading that is still arriving: theirs to feed, finish or give up, whoever owns the
 * folder it goes into and whatever their share on it has become since.
 */
export const runningUpload = async (
  db: Database,
  userId: string,
  id: string
): Promise<DriveNode | null> => {
  const node = await getNode(db, id);

  if (!node || node.kind !== "file" || node.status !== "uploading") {
    return null;
  }

  return node.createdBy === userId ? node : null;
};

/**
 * The folders above a node, root first, as far up as the person may see: the owner sees them all; someone it is
 * shared with sees from the highest folder shared with them down.
 */
export const crumbsFor = async (
  db: Database,
  userId: string,
  node: DriveNode
): Promise<DriveCrumb[]> => {
  const ids = ancestorIds(node.path);

  if (!ids.length) {
    return [];
  }

  const byId = await nodesById(db, ids);

  const chain = ids
    .map((id) => byId.get(id))
    .filter((n): n is DriveNode => !!n);

  let top = 0;

  if (node.userId !== userId) {
    const { held } = await sharesOn(db, userId, [...ids, node.id]);
    top = chain.findIndex((n) => held.has(n.id));

    if (top < 0) {
      return [];
    }
  }

  return chain.slice(top).map((n) => ({ id: n.id, name: n.name }));
};

/** Which shares with the person count: one owner's only, and only those that let the person edit. */
export interface ShareScope {
  ownerId?: string;
  editable?: boolean;
}

/**
 * The nodes others shared with the person (with them, or with everyone), every one of them: where Shared with me, a
 * search and the move picker look beyond the person's own drive. Whether the person still reaches one (a trashed
 * folder above it) is for `reachAll` to say.
 */
export const sharedRoots = async (
  db: Database,
  userId: string,
  scope: ShareScope = {}
): Promise<DriveNode[]> => {
  const shares = await db
    .select({ nodeId: driveShares.nodeId })
    .from(driveShares)
    .where(
      and(
        or(eq(driveShares.subject, userId), eq(driveShares.subject, EVERYONE)),
        scope.ownerId
          ? eq(driveShares.ownerId, scope.ownerId)
          : ne(driveShares.ownerId, userId),
        scope.editable ? eq(driveShares.role, "editor") : undefined
      )
    );

  const byId = await nodesById(
    db,
    shares.map((s) => s.nodeId)
  );

  return [...byId.values()].filter((n) => n.userId !== userId);
};

/** Roots per query when looking under them: each binds two values, and `where` keeps the rest under D1's 100. */
const ROOTS_PER_QUERY = 20;

/**
 * The nodes at or under what others shared with the person that match `where` (which binds at most 50 values), at
 * most `LIST_LIMIT` per slice of roots. Candidates, for `reachAll`.
 */
export const underShares = async (
  db: Database,
  userId: string,
  where: SQL | undefined,
  scope: ShareScope = {}
): Promise<DriveNode[]> => {
  const roots = await sharedRoots(db, userId, scope);
  const found = new Map<string, DriveNode>();

  for (const slice of chunks(roots, ROOTS_PER_QUERY)) {
    const under = slice.map((r) =>
      r.kind === "folder"
        ? defined(
            or(
              eq(driveNodes.id, r.id),
              sql`${driveNodes.path} GLOB ${`${subtreePrefix(r)}*`}`
            ),
            "the result of or"
          )
        : eq(driveNodes.id, r.id)
    );

    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk of ids per query to stay under D1's bound-variable limit; the chunks run in turn
    const rows = await db.query.driveNodes.findMany({
      where: and(or(...under), where),
      limit: LIST_LIMIT,
    });

    for (const n of rows) {
      found.set(n.id, n);
    }
  }

  return [...found.values()];
};

/* ---------- outside the workspace: links and invites ---------- */

/** Whether a link or invite still stands at `at`: not revoked, and not past its expiry. */
export const liveLink = (
  link: Pick<DriveLink, "revokedAt" | "expiresAt">,
  at = Date.now()
) => !link.revokedAt && (!link.expiresAt || Date.parse(link.expiresAt) > at);

/**
 * What someone outside the workspace brings besides the token: the password they typed, and the links a pass of
 * theirs is good for (the ids `readPasses` opened from their sealed pass cookies: a password typed or an invite's
 * code confirmed earlier).
 */
export interface LinkProof {
  password?: string | null;
  passes?: ReadonlySet<string>;
}

/** A link that opens: the link, the node it shares and who made it. */
export interface OpenLink {
  link: DriveLink;
  root: DriveNode;
  creator: { id: string; name: string };
}

/**
 * What a token opens: the shared node (`open`); or, before that, the password the link asks for (`wrong` when the
 * one given was not it), or the confirmation an invite asks of its invitee.
 */
export type LinkAccess =
  | { state: "open"; open: OpenLink }
  | { state: "password"; link: DriveLink; wrong: boolean }
  | { state: "invite"; link: DriveLink };

/**
 * The link a token opens, or null as if there were none: no such token, revoked, expired, sharing outside turned
 * off, or its creator no longer reaches the node it shares (deactivated, their share taken away, the node trashed,
 * under a trashed folder, deleted or still uploading). Only then does it ask for the password or the invitee's
 * confirmation, so a dead link never tells that it had one.
 */
export const openLink = async (
  db: Database,
  token: string,
  proof: LinkProof = {},
  at = Date.now()
): Promise<LinkAccess | null> => {
  if (!token || token.length > 128) {
    return null;
  }

  const link = await db.query.driveLinks.findFirst({
    where: eq(driveLinks.tokenHash, await sha256Hex(token)),
  });

  if (!link || !liveLink(link, at) || !(await externalSharingOn(db))) {
    return null;
  }

  const creator = await db.query.users.findFirst({
    where: eq(users.id, link.createdBy),
  });

  if (!creator?.active) {
    return null;
  }

  const root = await reach(db, creator.id, link.nodeId, "outside");

  if (!root) {
    return null;
  }

  const open: OpenLink = {
    link,
    root: root.node,
    creator: { id: creator.id, name: creator.name },
  };

  if (proof.passes?.has(link.id)) {
    return { state: "open", open };
  }

  if (link.kind === "invite") {
    return { state: "invite", link };
  }

  if (!link.passwordHash) {
    return { state: "open", open };
  }

  if (
    proof.password &&
    (await verifyPassword(proof.password, link.passwordHash))
  ) {
    return { state: "open", open };
  }

  return { state: "password", link, wrong: !!proof.password };
};

/** What a link reaches of a node: viewing it, never more, whatever its creator may do. */
export interface LinkReached {
  node: DriveNode;
  role: "viewer";
}

/** A node a link may show: the node it shares, or one under it when that is a folder. */
const underLink = (root: DriveNode, node: DriveNode): boolean =>
  node.id === root.id ||
  (root.kind === "folder" && node.path.startsWith(subtreePrefix(root)));

/**
 * The candidates an open link reaches, in the order given: those at or under the node it shares that its creator
 * reaches under `outside` (no trashed node or folder above, whole, still theirs to see), as a viewer.
 */
export const reachAllByLink = async (
  db: Database,
  open: OpenLink,
  candidates: readonly (DriveNode | string)[]
): Promise<LinkReached[]> => {
  const ids = candidates.filter(isId);

  const loaded = ids.length
    ? await nodesById(db, ids)
    : new Map<string, DriveNode>();

  const inside = candidates.flatMap((c) => {
    const node = isId(c) ? loaded.get(c) : c;

    return node && underLink(open.root, node) ? [node] : [];
  });

  const reached = await reachAll(db, open.link.createdBy, inside, "outside");

  return reached.map((r) => ({ node: r.node, role: "viewer" }));
};

/** One node an open link reaches, or null. */
export const reachByLink = async (
  db: Database,
  open: OpenLink,
  id: string
): Promise<LinkReached | null> => {
  const reachedByLink = await reachAllByLink(db, open, [id]);

  return reachedByLink[0] ?? null;
};

/** A file an open link may show: reached, a file, its bytes in the bucket. */
export const reachFileByLink = async (
  db: Database,
  open: OpenLink,
  id: string
): Promise<(LinkReached & { key: string }) | null> => {
  const reached = await reachByLink(db, open, id);

  if (!reached || reached.node.kind !== "file" || !reached.node.r2Key) {
    return null;
  }

  return { ...reached, key: reached.node.r2Key };
};

/** The folders above a node a link reaches, from the node it shares down: never a folder above that. */
export const crumbsByLink = async (
  db: Database,
  open: OpenLink,
  node: DriveNode
): Promise<DriveCrumb[]> => {
  const ids = ancestorIds(node.path);
  const from = ids.indexOf(open.root.id);

  if (node.id === open.root.id || from === -1) {
    return [];
  }

  const chain = ids.slice(from);
  const byId = await nodesById(db, chain);

  return chain
    .map((id) => byId.get(id))
    .filter((n): n is DriveNode => !!n)
    .map((n) => ({ id: n.id, name: n.name }));
};
