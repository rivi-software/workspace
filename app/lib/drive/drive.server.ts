/**
 * Drive: folders and files in D1 (`drive_nodes`, a materialized path per node), the bytes in the DRIVE bucket.
 * Everything here takes the person acting and answers only what they may reach, which `access.server.ts` decides:
 * this module finds the candidates (a folder's children, a view's rows, a search's matches, the move picker's folders)
 * and acts on what the gate lets through.
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "~/db";
import { driveNodes, driveShares, driveStars, users } from "~/db/schema";
import type { DriveNode } from "~/db/schema";
import { defined } from "~/lib/guards";

import { newId, nowIso } from "../ids";
import {
  chunks,
  crumbsFor,
  reach,
  reachAll,
  runningUpload,
  sharedRoots,
  underShares,
} from "./access.server";
import type { Reached, TrashPolicy } from "./access.server";
import {
  DRIVE_EXPIRY_DAYS,
  EVERYONE,
  LIST_LIMIT,
  MAX_DEPTH,
  MAX_FILE_BYTES,
  UPLOAD_ABANDON_HOURS,
  ancestorIds,
  canEdit,
  cleanName,
  compareRows,
  contentTypeFor,
  nextName,
  subtreePrefix,
} from "./drive";
import type {
  DriveCrumb,
  DriveDir,
  DriveRow,
  DriveShareRole,
  DriveSort,
  DriveView,
} from "./drive";

export class DriveError extends Error {
  override name = "DriveError";
}

interface Order {
  sort: DriveSort;
  dir: DriveDir;
}

const r2KeyFor = (ownerId: string, nodeId: string): string =>
  `drive/${ownerId}/${nodeId}`;

/** The path a child of `parent` carries: the parent's own path with the parent's id on the end. */
const childPath = (parent: DriveNode | null): string =>
  parent ? subtreePrefix(parent) : "/";

const getNode = async (db: Database, id: string): Promise<DriveNode | null> =>
  (await db.query.driveNodes.findFirst({ where: eq(driveNodes.id, id) })) ??
  null;

const rowOf = ({
  node: n,
  role,
  starred,
  shared,
  linked,
  owner,
}: Reached): DriveRow => ({
  id: n.id,
  kind: n.kind,
  name: n.name,
  contentType: n.contentType,
  size: n.size,
  updatedAt: n.updatedAt,
  createdAt: n.createdAt,
  trashedAt: n.trashedAt,
  starred,
  shared,
  linked,
  role,
  owner,
  parentId: n.parentId,
});

/** The rows of the candidates the person reaches under `trash`. */
const rowsFor = async (
  db: Database,
  userId: string,
  candidates: readonly (DriveNode | string)[],
  trash: TrashPolicy
): Promise<DriveRow[]> => {
  const reachable = await reachAll(db, userId, candidates, trash);

  return reachable.map(rowOf);
};

/* ---------- names ---------- */

/** The names in use beside `parent` (the owner's root when null), lowercased, trashed ones aside. */
const siblingNames = async (
  db: Database,
  ownerId: string,
  parentId: string | null,
  exceptId?: string
): Promise<Set<string>> => {
  const rows = await db
    .select({ id: driveNodes.id, name: driveNodes.name })
    .from(driveNodes)
    .where(
      and(
        parentId
          ? eq(driveNodes.parentId, parentId)
          : and(isNull(driveNodes.parentId), eq(driveNodes.userId, ownerId)),
        isNull(driveNodes.trashedAt)
      )
    );

  return new Set(
    rows.filter((r) => r.id !== exceptId).map((r) => r.name.toLowerCase())
  );
};

const requireName = (raw: string): string => {
  const name = cleanName(raw);

  if (!name) {
    throw new DriveError("Give it a name.");
  }

  return name;
};

/** A folder the person may put things in, or null for their own root. */
const writableFolder = async (
  db: Database,
  userId: string,
  parentId: string | null
): Promise<DriveNode | null> => {
  if (!parentId) {
    return null;
  }

  const parent = await reach(db, userId, parentId, "outside");

  if (!parent || parent.node.kind !== "folder") {
    throw new DriveError("That folder is gone.");
  }

  if (!canEdit(parent.role)) {
    throw new DriveError("You can only view that folder.");
  }

  if (ancestorIds(parent.node.path).length + 1 >= MAX_DEPTH) {
    throw new DriveError("Folders cannot nest any deeper here.");
  }

  return parent.node;
};

/* ---------- folders ---------- */

export const createFolder = async (
  db: Database,
  userId: string,
  parentId: string | null,
  rawName: string
): Promise<DriveNode> => {
  const parent = await writableFolder(db, userId, parentId);
  const ownerId = parent?.userId ?? userId;

  const name = nextName(
    requireName(rawName),
    await siblingNames(db, ownerId, parent?.id ?? null)
  );

  const id = newId("dn");
  const now = nowIso();
  await db.insert(driveNodes).values({
    id,
    userId: ownerId,
    parentId: parent?.id ?? null,
    path: childPath(parent),
    kind: "folder",
    name,
    contentType: "inode/directory",
    size: 0,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return defined(await getNode(db, id), "the folder just made");
};

/**
 * The folder at `segments` under `parentId`, made where it does not exist yet (an upload of a whole folder brings
 * its files with their paths). Answers the id of the last folder.
 */
export const ensureFolderPath = async (
  db: Database,
  userId: string,
  parentId: string | null,
  segments: string[]
): Promise<string | null> => {
  let current = parentId;

  for (const raw of segments) {
    const name = cleanName(raw);

    if (!name) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    const parent = await writableFolder(db, userId, current);
    const ownerId = parent?.userId ?? userId;

    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    const existing = await db.query.driveNodes.findFirst({
      where: and(
        parent
          ? eq(driveNodes.parentId, parent.id)
          : and(isNull(driveNodes.parentId), eq(driveNodes.userId, ownerId)),
        eq(driveNodes.kind, "folder"),
        isNull(driveNodes.trashedAt),
        sql`${driveNodes.name} = ${name} COLLATE NOCASE`
      ),
    });

    if (existing) {
      current = existing.id;
    } else {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each folder is made under the one before it
      const made = await createFolder(db, userId, current, name);
      current = made.id;
    }
  }

  return current;
};

/* ---------- uploads ---------- */

export interface UploadStart {
  node: DriveNode;
  uploadId: string | null;
}

/**
 * A file about to arrive: its row is made first (`status` uploading), so the key is settled and an abandoned upload
 * can be found later. Whole in one request, or in parts: then R2's multipart upload is opened and its id kept.
 */
export const startUpload = async (
  db: Database,
  env: Env,
  userId: string,
  input: {
    parentId: string | null;
    name: string;
    size: number;
    contentType?: string | null;
    multipart: boolean;
  }
): Promise<UploadStart> => {
  if (!Number.isFinite(input.size) || input.size < 0) {
    throw new DriveError("The file's size is unknown.");
  }

  if (input.size > MAX_FILE_BYTES) {
    throw new DriveError("A file can be 5 GB at most.");
  }

  const parent = await writableFolder(db, userId, input.parentId);
  const ownerId = parent?.userId ?? userId;

  const name = nextName(
    requireName(input.name),
    await siblingNames(db, ownerId, parent?.id ?? null)
  );

  const contentType = contentTypeFor(name, input.contentType);
  const id = newId("dn");
  const key = r2KeyFor(ownerId, id);
  let uploadId: string | null = null;

  if (input.multipart) {
    const upload = await env.DRIVE.createMultipartUpload(key, {
      httpMetadata: { contentType },
    });

    ({ uploadId } = upload);
  }

  const now = nowIso();
  await db.insert(driveNodes).values({
    id,
    userId: ownerId,
    parentId: parent?.id ?? null,
    path: childPath(parent),
    kind: "file",
    name,
    contentType,
    size: input.size,
    r2Key: key,
    status: "uploading",
    uploadId,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return {
    node: defined(await getNode(db, id), "the file just added"),
    uploadId,
  };
};

/** The file row of an upload the person started, still arriving. */
const uploadingNode = async (
  db: Database,
  userId: string,
  id: string
): Promise<DriveNode> => {
  const node = await runningUpload(db, userId, id);

  if (!node) {
    throw new DriveError("That upload is not running.");
  }

  return node;
};

export const uploadPart = async (
  env: Env,
  db: Database,
  userId: string,
  id: string,
  partNumber: number,
  body: ArrayBuffer
): Promise<{ partNumber: number; etag: string }> => {
  const node = await uploadingNode(db, userId, id);

  if (!node.uploadId || !node.r2Key) {
    throw new DriveError("That upload takes no parts.");
  }

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new DriveError("Part numbers run from 1 to 10000.");
  }

  const part = await env.DRIVE.resumeMultipartUpload(
    node.r2Key,
    node.uploadId
  ).uploadPart(partNumber, body);

  return { partNumber: part.partNumber, etag: part.etag };
};

/**
 * The upload is whole: a multipart upload is completed from its parts, and the row becomes a ready file with the size
 * the bucket holds. For a file sent whole, the caller has put the object already.
 */
export const finishUpload = async (
  env: Env,
  db: Database,
  userId: string,
  id: string,
  parts?: { partNumber: number; etag: string }[]
): Promise<DriveNode> => {
  const node = await uploadingNode(db, userId, id);

  if (!node.r2Key) {
    throw new DriveError("That upload has no file.");
  }

  if (node.uploadId) {
    if (!parts?.length) {
      throw new DriveError("The upload's parts are missing.");
    }

    await env.DRIVE.resumeMultipartUpload(node.r2Key, node.uploadId).complete(
      parts.toSorted((a, b) => a.partNumber - b.partNumber)
    );
  }

  const head = await env.DRIVE.head(node.r2Key);

  if (!head) {
    throw new DriveError("The file did not arrive.");
  }

  const now = nowIso();
  await db
    .update(driveNodes)
    .set({ status: "ready", uploadId: null, size: head.size, updatedAt: now })
    .where(eq(driveNodes.id, node.id));

  return defined(await getNode(db, node.id), "the file just finished");
};

const dropObject = async (env: Env, node: DriveNode): Promise<void> => {
  if (!node.r2Key) {
    return;
  }

  if (node.uploadId) {
    try {
      await env.DRIVE.resumeMultipartUpload(node.r2Key, node.uploadId).abort();
    } catch {
      // already gone, or completed by a request that raced this one
    }
  }

  await env.DRIVE.delete(node.r2Key);
};

/** An upload given up: its parts are dropped, its object (when any) too, and its row goes. */
export const abortUpload = async (
  env: Env,
  db: Database,
  userId: string,
  id: string
): Promise<void> => {
  const node = await runningUpload(db, userId, id);

  if (!node) {
    return;
  }

  await dropObject(env, node);
  await db.delete(driveNodes).where(eq(driveNodes.id, node.id));
};

/* ---------- listings ---------- */

export interface Listing {
  folder: {
    id: string;
    name: string;
    role: DriveRow["role"];
    owner: { id: string; name: string };
    starred: boolean;
    shared: boolean;
    linked: boolean;
  } | null;
  crumbs: DriveCrumb[];
  rows: DriveRow[];
}

/** A folder's contents (the person's own root when `folderId` is null), folders first, in the asked order. */
export const listFolder = async (
  db: Database,
  userId: string,
  folderId: string | null,
  order: Order
): Promise<Listing | null> => {
  let folder: Reached | null = null;

  if (folderId) {
    folder = await reach(db, userId, folderId, "outside");

    if (!folder || folder.node.kind !== "folder") {
      return null;
    }
  }

  const nodes = await db.query.driveNodes.findMany({
    where: and(
      folder
        ? eq(driveNodes.parentId, folder.node.id)
        : and(isNull(driveNodes.parentId), eq(driveNodes.userId, userId)),
      isNull(driveNodes.trashedAt)
    ),
    limit: LIST_LIMIT,
  });

  const foundRows = await rowsFor(db, userId, nodes, "outside");
  const rows = foundRows.toSorted(compareRows(order.sort, order.dir));

  return {
    folder: folder
      ? {
          id: folder.node.id,
          name: folder.node.name,
          role: folder.role,
          owner: folder.owner,
          starred: folder.starred,
          shared: folder.shared,
          linked: folder.linked,
        }
      : null,
    crumbs: folder ? await crumbsFor(db, userId, folder.node) : [],
    rows,
  };
};

/** Recent holds this many files, the newest. */
const RECENT_LIMIT = 60;

const escapeLike = (w: string) => w.replaceAll(/[\\%_]/gu, (c) => `\\${c}`);

const search = async (
  db: Database,
  userId: string,
  q: string
): Promise<DriveRow[]> => {
  const words = q.trim().split(/\s+/u).filter(Boolean).slice(0, 6);

  if (!words.length) {
    return [];
  }

  const matches = and(
    isNull(driveNodes.trashedAt),
    ...words.map(
      (w) => sql`${driveNodes.name} LIKE ${`%${escapeLike(w)}%`} ESCAPE '\\'`
    )
  );

  const own = await db.query.driveNodes.findMany({
    where: and(eq(driveNodes.userId, userId), matches),
    limit: LIST_LIMIT,
  });

  // What is shared with the person: the shared nodes themselves, and everything under a shared folder.
  const shared = await underShares(db, userId, matches);

  return rowsFor(db, userId, [...own, ...shared], "outside");
};

/**
 * A view's rows, or a search's: My Drive (the person's root), Shared with me (what others shared with them, directly
 * or with everyone), Recent (the files they own or added, the newest), Starred (their own stars), Trash (their own
 * trash, the top of each trashed subtree), or `{ search }`: names that contain every word typed, in their drive and
 * under what is shared with them. In the asked order, folders first.
 */
export const listView = async (
  db: Database,
  userId: string,
  view: DriveView | { search: string },
  order: Order
): Promise<DriveRow[]> => {
  const sorted = (rows: DriveRow[]) =>
    rows.toSorted(compareRows(order.sort, order.dir));

  if (view instanceof Object) {
    return sorted(await search(db, userId, view.search));
  }

  switch (view) {
    case "mine": {
      const listing = await listFolder(db, userId, null, order);

      return listing?.rows ?? [];
    }

    case "shared": {
      const sharedRootNodes = await sharedRoots(db, userId);
      const roots = sharedRootNodes.slice(0, LIST_LIMIT);

      return sorted(await rowsFor(db, userId, roots, "outside"));
    }

    case "recent": {
      const nodes = await db.query.driveNodes.findMany({
        where: and(
          or(eq(driveNodes.userId, userId), eq(driveNodes.createdBy, userId)),
          eq(driveNodes.kind, "file"),
          eq(driveNodes.status, "ready"),
          isNull(driveNodes.trashedAt)
        ),
        orderBy: (n, { desc }) => [desc(n.updatedAt)],
        limit: RECENT_LIMIT * 2,
      });

      const rows = await rowsFor(db, userId, nodes, "outside");

      return sorted(
        rows
          .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, RECENT_LIMIT)
      );
    }

    case "starred": {
      const stars = await db
        .select({ nodeId: driveStars.nodeId })
        .from(driveStars)
        .where(eq(driveStars.userId, userId))
        .limit(LIST_LIMIT);

      return sorted(
        await rowsFor(
          db,
          userId,
          stars.map((s) => s.nodeId),
          "outside"
        )
      );
    }

    case "trash": {
      const nodes = await db.query.driveNodes.findMany({
        where: and(
          eq(driveNodes.userId, userId),
          isNotNull(driveNodes.trashedAt)
        ),
        limit: LIST_LIMIT,
      });

      return sorted(await rowsFor(db, userId, nodes, "trash-view"));
    }

    default: {
      return [];
    }
  }
};

/* ---------- a node, for its page ---------- */

export type NodeDetails = Reached & { crumbs: DriveCrumb[] };

/** A reached node as a row of a listing: what the app on a phone reads after a change (docs/API.md). */
export const detailsRow = (details: Reached): DriveRow => {
  const n = details.node;

  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    contentType: n.contentType,
    size: n.size,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    trashedAt: n.trashedAt,
    starred: details.starred,
    shared: details.shared,
    linked: details.linked,
    role: details.role,
    owner: details.owner,
    parentId: n.parentId,
  };
};

/** A node for its page: the owner reaches what they trashed too, to preview, restore or delete it. */
export const nodeDetails = async (
  db: Database,
  userId: string,
  id: string
): Promise<NodeDetails | null> => {
  const reached = await reach(db, userId, id, "own-trash");

  if (!reached) {
    return null;
  }

  return { ...reached, crumbs: await crumbsFor(db, userId, reached.node) };
};

/** A node's row after a change, read again so its markers are what they are now; null when it is gone. */
export const nodeRow = async (
  db: Database,
  userId: string,
  id: string
): Promise<DriveRow | null> => {
  const details = await nodeDetails(db, userId, id);

  return details ? detailsRow(details) : null;
};

/* ---------- actions ---------- */

/** The nodes an action names that the person reaches, each once, 200 at most. */
const reachMany = (
  db: Database,
  userId: string,
  ids: string[],
  trash: TrashPolicy
): Promise<Reached[]> =>
  reachAll(db, userId, [...new Set(ids)].slice(0, 200), trash);

export const renameNode = async (
  db: Database,
  userId: string,
  id: string,
  rawName: string
): Promise<DriveNode> => {
  const r = await reach(db, userId, id, "outside");

  if (!r) {
    throw new DriveError("That is gone.");
  }

  if (!canEdit(r.role)) {
    throw new DriveError("You can only view it.");
  }

  const wanted = requireName(rawName);

  const name = nextName(
    wanted,
    await siblingNames(db, r.node.userId, r.node.parentId, r.node.id)
  );

  await db
    .update(driveNodes)
    .set({ name, updatedAt: nowIso() })
    .where(eq(driveNodes.id, r.node.id));

  return defined(await getNode(db, r.node.id), "the node just renamed");
};

/** Put `node` under `parent` (the owner's root when null): its path, and its subtree's paths with it. */
const placeNode = async (
  db: Database,
  node: DriveNode,
  parent: DriveNode | null,
  name: string
): Promise<void> => {
  const oldPrefix = subtreePrefix(node);
  const path = childPath(parent);
  await db
    .update(driveNodes)
    .set({ parentId: parent?.id ?? null, path, name, updatedAt: nowIso() })
    .where(eq(driveNodes.id, node.id));

  if (node.kind === "folder") {
    const newPrefix = subtreePrefix({ path, id: node.id });

    if (newPrefix !== oldPrefix) {
      await db.run(
        sql`UPDATE drive_nodes SET path = ${newPrefix} || substr(path, ${oldPrefix.length + 1}) WHERE path GLOB ${`${oldPrefix}*`}`
      );
    }
  }
};

/** Move the nodes into a folder, or to the person's own root. Within one drive only; never into itself. */
export const moveNodes = async (
  db: Database,
  userId: string,
  ids: string[],
  targetId: string | null
): Promise<number> => {
  const target = await writableFolder(db, userId, targetId);
  const ownerId = target?.userId ?? userId;
  let n = 0;

  for (const r of await reachMany(db, userId, ids, "outside")) {
    if (!canEdit(r.role)) {
      throw new DriveError(`You can only view ${r.node.name}.`);
    }

    if (r.node.userId !== ownerId) {
      throw new DriveError(
        "Things can only be moved within the drive they are in."
      );
    }

    if (
      target &&
      (target.id === r.node.id || target.path.startsWith(subtreePrefix(r.node)))
    ) {
      throw new DriveError("A folder cannot be moved into itself.");
    }

    if ((target?.id ?? null) === r.node.parentId) {
      continue;
    }

    const name = nextName(
      r.node.name,
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
      await siblingNames(db, ownerId, target?.id ?? null, r.node.id)
    );

    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await placeNode(db, r.node, target, name);
    n += 1;
  }

  return n;
};

export const setStar = async (
  db: Database,
  userId: string,
  ids: string[],
  on: boolean
): Promise<number> => {
  const reached = await reachMany(db, userId, ids, "outside");

  for (const r of reached) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one star at a time, in the order the nodes were named
    await (on
      ? db
          .insert(driveStars)
          .values({ userId, nodeId: r.node.id })
          .onConflictDoNothing()
      : db
          .delete(driveStars)
          .where(
            and(eq(driveStars.userId, userId), eq(driveStars.nodeId, r.node.id))
          ));
  }

  return reached.length;
};

/** To the trash: the node is marked, its subtree goes with it, and the owner's trash lists it. */
export const trashNodes = async (
  db: Database,
  userId: string,
  ids: string[]
): Promise<string[]> => {
  const done: string[] = [];
  const now = nowIso();

  for (const r of await reachMany(db, userId, ids, "outside")) {
    if (!canEdit(r.role)) {
      throw new DriveError(`You can only view ${r.node.name}.`);
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await db
      .update(driveNodes)
      .set({ trashedAt: now, updatedAt: now })
      .where(eq(driveNodes.id, r.node.id));
    done.push(r.node.id);
  }

  return done;
};

/** Out of the trash, back where it was, or at the root when that folder is in the trash itself or gone. */
export const restoreNodes = async (
  db: Database,
  userId: string,
  ids: string[]
): Promise<number> => {
  let n = 0;

  for (const r of await reachMany(db, userId, ids, "own-trash")) {
    if (r.role !== "owner" || !r.node.trashedAt) {
      continue;
    }

    // Its folder, unless that is in the trash itself (or under a trashed folder), or gone.
    const parentReach = r.node.parentId
      ? // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
        await reach(db, userId, r.node.parentId, "outside")
      : null;

    const parent = parentReach?.node ?? null;

    const name = nextName(
      r.node.name,
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
      await siblingNames(db, userId, parent?.id ?? null, r.node.id)
    );

    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await db
      .update(driveNodes)
      .set({ trashedAt: null, updatedAt: nowIso() })
      .where(eq(driveNodes.id, r.node.id));

    if ((parent?.id ?? null) !== r.node.parentId || name !== r.node.name) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
      await placeNode(db, { ...r.node, trashedAt: null }, parent, name);
    }

    n += 1;
  }

  return n;
};

/** The node's whole subtree, itself included. */
const subtreeOf = async (
  db: Database,
  node: DriveNode
): Promise<DriveNode[]> => {
  if (node.kind !== "folder") {
    return [node];
  }

  const under = await db.query.driveNodes.findMany({
    where: sql`${driveNodes.path} GLOB ${`${subtreePrefix(node)}*`}`,
  });

  return [node, ...under];
};

const deleteSubtree = async (
  env: Env,
  db: Database,
  node: DriveNode
): Promise<void> => {
  const all = await subtreeOf(db, node);
  const keys: string[] = [];

  for (const n of all) {
    if (n.uploadId) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
      await dropObject(env, n);
    } else if (n.r2Key) {
      keys.push(n.r2Key);
    }
  }

  for (const slice of chunks(keys, 1000)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await env.DRIVE.delete(slice);
  }

  for (const slice of chunks(all.map((n) => n.id))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await db.delete(driveNodes).where(inArray(driveNodes.id, slice));
  }
};

/** Gone for good, from the owner's trash only: the rows, the objects, the shares and stars with them. */
export const deleteForever = async (
  env: Env,
  db: Database,
  userId: string,
  ids: string[]
): Promise<number> => {
  let n = 0;

  for (const r of await reachMany(db, userId, ids, "own-trash")) {
    if (r.role !== "owner" || !r.node.trashedAt) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await deleteSubtree(env, db, r.node);
    n += 1;
  }

  return n;
};

export const emptyTrash = async (
  env: Env,
  db: Database,
  userId: string
): Promise<number> => {
  let n = 0;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    const rows = await db.query.driveNodes.findMany({
      where: and(
        eq(driveNodes.userId, userId),
        isNotNull(driveNodes.trashedAt)
      ),
      limit: 100,
    });

    if (!rows.length) {
      return n;
    }

    for (const node of rows) {
      // A node under a trashed folder goes with the folder; deleting it first would be fine too, but once is enough.
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
      if ((await getNode(db, node.id)) === null) {
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
      await deleteSubtree(env, db, node);
      n += 1;
    }
  }
};

/**
 * Housekeeping for one person, a batch at a time: what has been in the trash for 30 days is deleted for good, and an
 * upload that never finished in a day is abandoned.
 */
export const pruneDrive = async (
  env: Env,
  db: Database,
  userId: string,
  batch = 50
): Promise<{ deleted: number; abandoned: number }> => {
  const cutoff = new Date(
    Date.now() - DRIVE_EXPIRY_DAYS * 86_400_000
  ).toISOString();

  const old = await db.query.driveNodes.findMany({
    where: and(eq(driveNodes.userId, userId), lt(driveNodes.trashedAt, cutoff)),
    limit: batch,
  });

  let deleted = 0;

  for (const node of old) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    if ((await getNode(db, node.id)) === null) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await deleteSubtree(env, db, node);
    deleted += 1;
  }

  const stale = new Date(
    Date.now() - UPLOAD_ABANDON_HOURS * 3_600_000
  ).toISOString();

  const abandoned = await db.query.driveNodes.findMany({
    where: and(
      eq(driveNodes.userId, userId),
      eq(driveNodes.status, "uploading"),
      lt(driveNodes.createdAt, stale)
    ),
    limit: batch,
  });

  for (const node of abandoned) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await dropObject(env, node);
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads what the one before changed, so they run in order
    await db.delete(driveNodes).where(eq(driveNodes.id, node.id));
  }

  return { deleted, abandoned: abandoned.length };
};

/* ---------- sharing ---------- */

export interface ShareView {
  id: string;
  subject: string;
  role: DriveShareRole;
  person: { id: string; name: string; email: string } | null;
}

const ownedNode = async (
  db: Database,
  userId: string,
  id: string
): Promise<DriveNode> => {
  const r = await reach(db, userId, id, "outside");

  if (!r) {
    throw new DriveError("That is gone.");
  }

  if (r.role !== "owner") {
    throw new DriveError("Only the owner can share it.");
  }

  return r.node;
};

export const listShares = async (
  db: Database,
  userId: string,
  nodeId: string
): Promise<ShareView[]> => {
  const node = await ownedNode(db, userId, nodeId);

  const rows = await db
    .select({
      id: driveShares.id,
      subject: driveShares.subject,
      role: driveShares.role,
      personId: users.id,
      personName: users.name,
      personEmail: users.email,
    })
    .from(driveShares)
    .leftJoin(users, eq(users.id, driveShares.userId))
    .where(eq(driveShares.nodeId, node.id))
    .orderBy(asc(driveShares.createdAt));

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    role: r.role,
    person: r.personId
      ? {
          id: r.personId,
          name: defined(r.personName, "the name of a person shared with"),
          email: defined(r.personEmail, "the email of a person shared with"),
        }
      : null,
  }));
};

/** Share a node of the person's with a colleague or with everyone, or change the role of that share. */
export const setShare = async (
  db: Database,
  userId: string,
  nodeId: string,
  subject: string,
  role: DriveShareRole
): Promise<void> => {
  const node = await ownedNode(db, userId, nodeId);
  let personId: string | null = null;

  if (subject !== EVERYONE) {
    if (subject === userId) {
      throw new DriveError("It is yours already.");
    }

    const person = await db.query.users.findFirst({
      where: and(eq(users.id, subject), eq(users.active, true)),
    });

    if (!person) {
      throw new DriveError("Choose someone in the workspace.");
    }

    personId = person.id;
  }

  await db
    .insert(driveShares)
    .values({
      id: newId("ds"),
      nodeId: node.id,
      ownerId: userId,
      subject,
      userId: personId,
      role,
    })
    .onConflictDoUpdate({
      target: [driveShares.nodeId, driveShares.subject],
      set: { role },
    });
};

export const removeShare = async (
  db: Database,
  userId: string,
  nodeId: string,
  subject: string
): Promise<void> => {
  const node = await ownedNode(db, userId, nodeId);
  await db
    .delete(driveShares)
    .where(
      and(eq(driveShares.nodeId, node.id), eq(driveShares.subject, subject))
    );
};

/** The people a node can be shared with: everyone active in the workspace but the person themselves. */
export const colleagues = async (db: Database, userId: string) => {
  const rows = await db.query.users.findMany({
    where: and(eq(users.active, true), ne(users.id, userId)),
    orderBy: (u) => [asc(u.name)],
  });

  return rows.map((u) => ({ id: u.id, name: u.name, email: u.email }));
};

/* ---------- the move picker ---------- */

export interface FolderOption {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * The folders the nodes could move to, for the picker: for the person's own things, every folder of theirs; for
 * things in someone's shared folder, the folders of that owner's the person may edit. Flat, by name, with each
 * folder's parent, so the client draws the tree; a folder whose parent is not on offer (a shared folder's) sits at the
 * top. The root is the owner's drive, which only the owner may use.
 */
export const moveTargets = async (
  db: Database,
  userId: string,
  ids: string[]
): Promise<{ ownerId: string; root: boolean; folders: FolderOption[] }> => {
  const reached = await reachMany(db, userId, ids, "outside");
  const owners = new Set(reached.map((r) => r.node.userId));

  if (owners.size > 1) {
    throw new DriveError(
      "Things can only be moved within the drive they are in."
    );
  }

  const ownerId = [...owners][0] ?? userId;

  const folder = and(
    eq(driveNodes.kind, "folder"),
    isNull(driveNodes.trashedAt)
  );

  const candidates =
    ownerId === userId
      ? await db.query.driveNodes.findMany({
          where: and(eq(driveNodes.userId, userId), folder),
          limit: LIST_LIMIT,
        })
      : await underShares(db, userId, folder, { ownerId, editable: true });

  const reachable = await reachAll(db, userId, candidates, "outside");

  const folders = reachable
    .filter((r) => canEdit(r.role))
    .map((r) => r.node)
    .toSorted((a, b) => Number(a.name > b.name) - Number(a.name < b.name));

  const offered = new Set(folders.map((n) => n.id));

  return {
    ownerId,
    root: ownerId === userId,
    folders: folders.map((n) => ({
      id: n.id,
      name: n.name,
      parentId: n.parentId && offered.has(n.parentId) ? n.parentId : null,
    })),
  };
};

/* ---------- storage ---------- */

export const storageUsed = async (
  db: Database,
  userId: string
): Promise<number> => {
  const [row] = await db
    .select({ bytes: sql<number>`coalesce(sum(${driveNodes.size}), 0)` })
    .from(driveNodes)
    .where(
      and(
        eq(driveNodes.userId, userId),
        eq(driveNodes.kind, "file"),
        eq(driveNodes.status, "ready")
      )
    );

  return Number(row?.bytes ?? 0);
};
