/**
 * The Drive section of the Workspace API (docs/API.md): a folder or a view, a node, a file's bytes, uploads, and
 * the changes to nodes, over the same server modules the console's Drive routes and `app/lib/drive/actions.ts` call.
 */
import type { Database } from "~/db";
import { reachFile } from "~/lib/drive/access.server";
import {
  canEdit,
  isDriveSort,
  isDriveView,
  previewOf,
} from "~/lib/drive/drive";
import type {
  DriveDir,
  DriveRow,
  DriveSort,
  DriveView,
} from "~/lib/drive/drive";
import {
  createFolder,
  deleteForever,
  detailsRow,
  emptyTrash,
  listFolder,
  listShares,
  listView,
  moveNodes,
  nodeDetails,
  nodeRow,
  renameNode,
  restoreNodes,
  setStar,
  storageUsed,
  trashNodes,
} from "~/lib/drive/drive.server";
import { fileResponse } from "~/lib/drive/serve.server";
import { handleDriveUpload } from "~/lib/drive/upload.server";

import { field, fieldOrNull, idsOf, readBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiContext, ApiRoute } from "./routing.server";

/** Recent reads newest first unless asked otherwise. */
const defaultSort = (view: DriveView): DriveSort =>
  view === "recent" ? "updated" : "name";

const defaultDir = (sort: DriveSort): DriveDir =>
  sort === "name" ? "asc" : "desc";

/** A node's row after a change; a problem when it is gone. */
const rowAfter = async (
  db: Database,
  userId: string,
  id: string
): Promise<DriveRow> => {
  const row = await nodeRow(db, userId, id);

  if (!row) {
    throw new ApiRequestError("That is gone.", 404);
  }

  return row;
};

const list = async (context: ApiContext): Promise<Response> => {
  const { db, user, query } = context;
  const q = (query.get("q") ?? "").trim();
  const folderId = query.get("folder");
  const askedView = query.get("view") ?? undefined;
  const view: DriveView = isDriveView(askedView) ? askedView : "mine";
  const askedSort = query.get("sort") ?? undefined;

  const sort: DriveSort = isDriveSort(askedSort)
    ? askedSort
    : defaultSort(view);

  const askedDir = query.get("dir");

  const dir: DriveDir =
    askedDir === "asc" || askedDir === "desc" ? askedDir : defaultDir(sort);

  const order = { sort, dir };
  const used = await storageUsed(db, user.id);

  if (folderId) {
    const listing = await listFolder(db, user.id, folderId, order);

    if (!listing) {
      throw new ApiRequestError("That folder is not yours.", 404);
    }

    return json({
      view,
      q: "",
      sort,
      dir,
      folder: listing.folder,
      crumbs: listing.crumbs,
      rows: listing.rows,
      canWrite: canEdit(listing.folder?.role),
      used,
    });
  }

  if (!q && view === "mine") {
    const listing = await listFolder(db, user.id, null, order);

    return json({
      view,
      q,
      sort,
      dir,
      folder: null,
      crumbs: [],
      rows: listing?.rows ?? [],
      canWrite: true,
      used,
    });
  }

  const rows = await listView(db, user.id, q ? { search: q } : view, order);

  return json({
    view,
    q,
    sort,
    dir,
    folder: null,
    crumbs: [],
    rows,
    canWrite: false,
    used,
  });
};

const node = async (context: ApiContext): Promise<Response> => {
  const { db, user, params } = context;
  const details = await nodeDetails(db, user.id, params.id ?? "");

  if (!details) {
    throw new ApiRequestError("That is gone.", 404);
  }

  const n = details.node;

  const shares =
    details.role === "owner" ? await listShares(db, user.id, n.id) : [];

  return json({
    node: detailsRow(details),
    crumbs: details.crumbs,
    preview: n.kind === "file" ? previewOf(n.contentType, n.name) : null,
    shares: shares.map((s) => ({ person: s.person, role: s.role })),
  });
};

const file = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, params, request, query } = context;
  // The owner reads a file they trashed from their trash, as on the file page.
  const reached = await reachFile(db, user.id, params.id ?? "", "own-trash");

  if (!reached) {
    throw new ApiRequestError("That file is gone.", 404);
  }

  const res = await fileResponse(request, env.DRIVE, reached, {
    download: query.get("download") === "1",
    cacheControl: "private, max-age=3600",
  });

  if (!res) {
    throw new ApiRequestError("That file is gone.", 404);
  }

  return res;
};

const upload = ({ request, env, db, user }: ApiContext): Promise<Response> =>
  handleDriveUpload(request, env, db, user);

const newFolder = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const body = await readBody(request);

  const made = await createFolder(
    db,
    user.id,
    fieldOrNull(body, "parentId"),
    field(body, "name")
  );

  return json({ ok: true, node: await rowAfter(db, user.id, made.id) });
};

const rename = async (context: ApiContext): Promise<Response> => {
  const { db, user, request, params } = context;
  const body = await readBody(request);

  const renamed = await renameNode(
    db,
    user.id,
    params.id ?? "",
    field(body, "name")
  );

  return json({ ok: true, node: await rowAfter(db, user.id, renamed.id) });
};

const star = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const body = await readBody(request);
  const count = await setStar(db, user.id, idsOf(body), body.on !== false);

  return json({ ok: true, count });
};

const trash = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const done = await trashNodes(db, user.id, idsOf(await readBody(request)));

  return json({ ok: true, count: done.length });
};

const restore = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const count = await restoreNodes(db, user.id, idsOf(await readBody(request)));

  return json({ ok: true, count });
};

const remove = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request } = context;

  const count = await deleteForever(
    env,
    db,
    user.id,
    idsOf(await readBody(request))
  );

  return json({ ok: true, count });
};

const move = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const body = await readBody(request);

  const count = await moveNodes(
    db,
    user.id,
    idsOf(body),
    fieldOrNull(body, "targetId")
  );

  return json({ ok: true, count });
};

const emptyTrashRoute = async (context: ApiContext): Promise<Response> => {
  const { db, env, user } = context;

  return json({ ok: true, count: await emptyTrash(env, db, user.id) });
};

export const driveRoutes: ApiRoute[] = [
  { method: "GET", path: "/drive", handler: list },
  { method: "GET", path: "/drive/nodes/:id", handler: node },
  { method: "GET", path: "/drive/files/:id", handler: file },
  { method: "PUT", path: "/drive/upload", writes: true, handler: upload },
  { method: "POST", path: "/drive/upload", writes: true, handler: upload },
  { method: "POST", path: "/drive/folders", writes: true, handler: newFolder },
  {
    method: "POST",
    path: "/drive/nodes/:id/rename",
    writes: true,
    handler: rename,
  },
  { method: "POST", path: "/drive/nodes/star", writes: true, handler: star },
  { method: "POST", path: "/drive/nodes/trash", writes: true, handler: trash },
  {
    method: "POST",
    path: "/drive/nodes/restore",
    writes: true,
    handler: restore,
  },
  {
    method: "POST",
    path: "/drive/nodes/delete",
    writes: true,
    handler: remove,
  },
  { method: "POST", path: "/drive/nodes/move", writes: true, handler: move },
  {
    method: "POST",
    path: "/drive/trash/empty",
    writes: true,
    handler: emptyTrashRoute,
  },
];
