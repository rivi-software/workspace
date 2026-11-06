/**
 * The server functions the Drive components call: an intent on some nodes (a folder made, a rename, a move, stars,
 * the trash and back, deleting for good, sharing, links outside the workspace), the folders a move could go to, a
 * node's sharing, and the folder a whole-folder upload lands in. A plain module: it imports the `*.server.ts` modules
 * for its handlers only.
 */
import { createServerFn } from "@tanstack/react-start";

import { field, formData, formPost } from "~/lib/forms";
import { stringList, stringOrNull } from "~/lib/guards";
import type { AppContext } from "~/lib/request.server";
import { appContext } from "~/lib/request.server";
import { setExternalSharing } from "~/lib/workspace-settings.server";

import { EVERYONE, isShareRole } from "./drive";
import {
  DriveError,
  colleagues,
  createFolder,
  deleteForever,
  emptyTrash,
  ensureFolderPath,
  listShares,
  moveNodes,
  moveTargets,
  removeShare,
  renameNode,
  restoreNodes,
  setShare,
  setStar,
  trashNodes,
} from "./drive.server";
import type { FolderOption, ShareView } from "./drive.server";
import {
  createExternalShare,
  listExternalShares,
  revokeExternalShare,
} from "./links.server";
import type { ExternalSharing } from "./links.server";

/** The node ids a form names: `ids` as a JSON array, or `id` once. */
const readIds = (data: FormData): string[] => {
  const raw = field(data, "ids");

  if (raw) {
    try {
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // not JSON: ids separated by whitespace or commas
    }

    return raw.split(/[\s,]+/u).filter(Boolean);
  }

  const one = field(data, "id");

  return one ? [one] : [];
};

/** The `expires` field of a new link: an ISO time, `null` for "never", nothing for the default term. */
const expiryOf = (expires: string): string | null | undefined => {
  if (!expires) {
    return undefined;
  }

  return expires === "never" ? null : expires;
};

export type DriveResult =
  | {
      ok: true;
      intent: string;
      count: number;
      id?: string;
      name?: string;
      /** A new link's address. */
      url?: string;
      undo?: { intent: string; ids: string[] };
    }
  | { ok: false; error: string };

/** The `link` intent: a link outside the workspace, or an invite for `email`. */
const makeLink = async (
  { db, env, user }: AppContext,
  data: FormData
): Promise<DriveResult> => {
  const { link, url } = await createExternalShare(
    env,
    db,
    user,
    field(data, "id"),
    {
      kind: field(data, "kind") === "invite" ? "invite" : "link",
      email: field(data, "email"),
      password: field(data, "password"),
      allowDownload: field(data, "downloads") !== "0",
      expiresAt: expiryOf(field(data, "expires")),
    }
  );

  return { ok: true, intent: "link", count: 1, id: link.id, url };
};

/** The `share` intent: a node shared with a person or with everyone, in a role. */
const makeShare = async (
  { db, user }: AppContext,
  data: FormData
): Promise<DriveResult> => {
  const role = field(data, "role", "viewer");

  if (!isShareRole(role)) {
    return { ok: false, error: "Choose a role." };
  }

  await setShare(
    db,
    user.id,
    field(data, "id"),
    field(data, "subject") || EVERYONE,
    role
  );

  return { ok: true, intent: "share", count: 1 };
};

/**
 * One intent: `folder` (a new folder in `parent`), `rename`, `move` (to `target`, or the root when empty), `star`,
 * `unstar`, `trash` (with an undo that restores), `restore`, `delete` (forever, from the trash), `empty-trash`,
 * `share` (`subject` a person's id or "everyone", `role`), `unshare`, `link` (a link outside the workspace, or with
 * `kind` "invite" one for `email`; `password`, `downloads` "0" to forbid them, `expires` an ISO time or "never",
 * else `LINK_DEFAULT_DAYS`) and `revoke-link` (`link`, its id).
 */
export const driveAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<DriveResult> => {
    const context = await appContext();
    const { db, env, user } = context;
    const intent = field(data, "intent");
    const ids = readIds(data);

    try {
      switch (intent) {
        case "folder": {
          const folder = await createFolder(
            db,
            user.id,
            field(data, "parent") || null,
            field(data, "name")
          );

          return {
            ok: true,
            intent,
            count: 1,
            id: folder.id,
            name: folder.name,
          };
        }

        case "rename": {
          const node = await renameNode(
            db,
            user.id,
            field(data, "id"),
            field(data, "name")
          );

          return { ok: true, intent, count: 1, id: node.id, name: node.name };
        }

        case "move": {
          return {
            ok: true,
            intent,
            count: await moveNodes(
              db,
              user.id,
              ids,
              field(data, "target") || null
            ),
          };
        }

        case "star":
        case "unstar": {
          return {
            ok: true,
            intent,
            count: await setStar(db, user.id, ids, intent === "star"),
          };
        }

        case "trash": {
          const done = await trashNodes(db, user.id, ids);

          return {
            ok: true,
            intent,
            count: done.length,
            undo: { intent: "restore", ids: done },
          };
        }

        case "restore": {
          return {
            ok: true,
            intent,
            count: await restoreNodes(db, user.id, ids),
          };
        }

        case "delete": {
          return {
            ok: true,
            intent,
            count: await deleteForever(env, db, user.id, ids),
          };
        }

        case "empty-trash": {
          return {
            ok: true,
            intent,
            count: await emptyTrash(env, db, user.id),
          };
        }

        case "share": {
          return await makeShare(context, data);
        }

        case "unshare": {
          await removeShare(
            db,
            user.id,
            field(data, "id"),
            field(data, "subject") || EVERYONE
          );

          return { ok: true, intent, count: 1 };
        }

        case "link": {
          return await makeLink(context, data);
        }

        case "revoke-link": {
          const link = await revokeExternalShare(
            db,
            user.id,
            field(data, "link")
          );

          return { ok: true, intent, count: 1, id: link.id };
        }

        default: {
          break;
        }
      }

      return { ok: false, error: "Unknown action." };
    } catch (error) {
      if (error instanceof DriveError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

export type MoveTargetsResult =
  | { ok: true; root: boolean; folders: FolderOption[] }
  | { ok: false; error: string };

/** The folders the move dialog offers for some nodes. */
export const driveMoveTargets = createServerFn({ method: "POST" })
  .validator((d: { ids: string[] }) => ({
    ids: Array.isArray(d?.ids)
      ? d.ids.filter((x): x is string => typeof x === "string")
      : [],
  }))
  .handler(async ({ data }): Promise<MoveTargetsResult> => {
    const { db, user } = await appContext();

    try {
      const { root, folders } = await moveTargets(db, user.id, data.ids);

      return { ok: true, root, folders };
    } catch (error) {
      if (error instanceof DriveError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

export type SharingResult =
  | {
      ok: true;
      /** Inside the workspace: the owner's shares, and who they could share with (empty for anyone else). */
      shares: ShareView[];
      people: { id: string; name: string; email: string }[];
      /** Outside the workspace: the node's links and invites, for anyone who reaches it. */
      external: ExternalSharing;
    }
  | { ok: false; error: string };

/** Who a node is shared with, inside and outside the workspace, and who it could be shared with, for the share dialog. */
export const driveSharing = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => ({ id: String(d?.id ?? "") }))
  .handler(async ({ data }): Promise<SharingResult> => {
    const { db, env, user } = await appContext();

    try {
      const external = await listExternalShares(env, db, user.id, data.id);

      const [shares, people] = external.owner
        ? await Promise.all([
            listShares(db, user.id, data.id),
            colleagues(db, user.id),
          ])
        : [[], []];

      return { ok: true, shares, people, external };
    } catch (error) {
      if (error instanceof DriveError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

/** The folder a file of a whole-folder upload goes into, made along its relative path where needed. */
export const driveFolderPath = createServerFn({ method: "POST" })
  .validator((d: { parent: string | null; segments: string[] }) => ({
    parent: stringOrNull(d?.parent) || null,
    segments: stringList(d?.segments).slice(0, 32),
  }))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; folderId: string | null } | { ok: false; error: string }
    > => {
      const { db, user } = await appContext();

      try {
        return {
          ok: true,
          folderId: await ensureFolderPath(
            db,
            user.id,
            data.parent,
            data.segments
          ),
        };
      } catch (error) {
        if (error instanceof DriveError) {
          return { ok: false, error: error.message };
        }

        throw error;
      }
    }
  );

/** Settings → Drive, for an admin: `external-sharing` turns sharing outside the workspace on (`on` checked) or off. */
export const driveAdminAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<{ error?: string; message?: string }> => {
    const { db, user } = await appContext();

    if (user.role !== "admin") {
      return { error: "Only an admin can change this." };
    }

    if (field(data, "intent") !== "external-sharing") {
      return { error: "Unknown action." };
    }

    const on = data.get("on") === "on";
    await setExternalSharing(db, user.id, on);
    console.log(
      JSON.stringify({ event: "drive.external-sharing", on, by: user.id })
    );

    return {
      message: on
        ? "Sharing outside the workspace is on."
        : "Sharing outside the workspace is off. Existing links stay off until it is on again.",
    };
  });
