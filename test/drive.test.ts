import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { driveNodes } from "~/db/schema";
import {
  reach,
  reachAll,
  reachFile,
  runningUpload,
} from "~/lib/drive/access.server";
import type { TrashPolicy } from "~/lib/drive/access.server";
import {
  ancestorIds,
  cleanName,
  contentTypeFor,
  fileKind,
  formatSize,
  nextName,
  previewOf,
} from "~/lib/drive/drive";
import type { DriveRole } from "~/lib/drive/drive";
import {
  DriveError,
  abortUpload,
  colleagues,
  createFolder,
  deleteForever,
  emptyTrash,
  ensureFolderPath,
  finishUpload,
  listFolder,
  listShares,
  listView,
  moveNodes,
  moveTargets,
  nodeDetails,
  pruneDrive,
  removeShare,
  renameNode,
  restoreNodes,
  setShare,
  setStar,
  startUpload,
  storageUsed,
  trashNodes,
  uploadPart,
} from "~/lib/drive/drive.server";

import {
  db,
  defined,
  mailbox,
  rejection,
  rejectionIncludes,
  sorted,
} from "./fixtures";

const byName = { sort: "name", dir: "asc" } as const;

/** A node's row as stored: its path and place, which the tree's rules are about. */
const getNode = async (id: string) =>
  (await db.query.driveNodes.findFirst({ where: eq(driveNodes.id, id) })) ??
  null;

/** A small file, sent whole, as the upload route does it. */
const putFile = async (
  userId: string,
  parentId: string | null,
  name: string,
  text: string,
  contentType?: string
) => {
  const bytes = new TextEncoder().encode(text);

  const { node } = await startUpload(db, env, userId, {
    parentId,
    name,
    size: bytes.byteLength,
    contentType,
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes, {
    httpMetadata: { contentType: node.contentType },
  });

  return finishUpload(env, db, userId, node.id);
};

describe("drive names and kinds", () => {
  it("cleans names and finds the next free one", () => {
    expect({
      "  report/2026\u0000.pdf ": cleanName("  report/2026\u0000.pdf "),
      "..": cleanName(".."),
      "   ": cleanName("   "),
    }).toStrictEqual({
      "  report/2026\u0000.pdf ": "report2026.pdf",
      "..": "",
      "   ": "",
    });
    const taken = new Set(["report.pdf", "report (2).pdf", "notes"]);
    expect({
      "Report.PDF": nextName("Report.PDF", taken),
      notes: nextName("notes", taken),
      "other.txt": nextName("other.txt", taken),
      "/": ancestorIds("/"),
      "/dn_a/dn_b/": ancestorIds("/dn_a/dn_b/"),
    }).toStrictEqual({
      "Report.PDF": "Report (3).PDF",
      notes: "notes (2)",
      "other.txt": "other.txt",
      "/": [],
      "/dn_a/dn_b/": ["dn_a", "dn_b"],
    });
  });

  it("knows a file's type from the browser or its extension, and its kind", () => {
    expect({
      "song.mp3": contentTypeFor("song.mp3", ""),
      "song.mp3 (2)": contentTypeFor("song.mp3", "application/octet-stream"),
      "x.unknown": contentTypeFor("x.unknown", null),
      "a.png": contentTypeFor("a.png", "image/PNG; charset=x"),
      "image/png": fileKind("image/png", "a.png", "file"),
      "application/zip": fileKind("application/zip", "a.zip", "file"),
      "text/typescript": fileKind("text/typescript", "a.ts", "file"),
      "text/plain": fileKind("text/plain", "a.txt", "file"),
      "application/octet-stream": fileKind(
        "application/octet-stream",
        "a.bin",
        "file"
      ),
      "inode/directory": fileKind("inode/directory", "x", "folder"),
      "image/svg+xml": previewOf("image/svg+xml", "a.svg"),
      "application/pdf": previewOf("application/pdf", "a.pdf"),
      formatSize: formatSize(512),
      formatSize2: formatSize(3 * 1024 * 1024),
      formatSize3: formatSize(1536 * 1024 * 1024),
    }).toStrictEqual({
      "song.mp3": "audio/mpeg",
      "song.mp3 (2)": "audio/mpeg",
      "x.unknown": "application/octet-stream",
      "a.png": "image/png",
      "image/png": "image",
      "application/zip": "archive",
      "text/typescript": "code",
      "text/plain": "text",
      "application/octet-stream": "file",
      "inode/directory": "folder",
      "image/svg+xml": null,
      "application/pdf": "pdf",
      formatSize: "512 B",
      formatSize2: "3.0 MB",
      formatSize3: "1.5 GB",
    });
  });
});

describe("the gate", () => {
  it("answers each person's role under each trash policy, past a trashed folder and an upload", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("gate-owner", "Owner");
    const viewer = await mailbox("gate-viewer", "Viewer");
    const editor = await mailbox("gate-editor", "Editor");
    const anyone = await mailbox("gate-anyone", "Anyone");
    const people = [owner, viewer, editor, anyone];
    // Team is shared with the viewer and the editor; Hall, inside it, with everyone.
    const team = await createFolder(db, owner.id, null, "Team");
    const hall = await createFolder(db, owner.id, team.id, "Hall");
    await setShare(db, owner.id, team.id, viewer.id, "viewer");
    await setShare(db, owner.id, team.id, editor.id, "editor");
    await setShare(db, owner.id, hall.id, "everyone", "viewer");
    const live = await putFile(owner.id, hall.id, "live.txt", "live");
    const privy = await putFile(owner.id, team.id, "team-only.txt", "team");
    const old = await createFolder(db, owner.id, hall.id, "Old");
    const inner = await putFile(owner.id, old.id, "inner.txt", "inner");
    const gone = await putFile(owner.id, old.id, "gone.txt", "gone");
    const binned = await putFile(owner.id, hall.id, "binned.txt", "binned");
    await trashNodes(db, owner.id, [gone.id]);
    await trashNodes(db, owner.id, [old.id, binned.id]);

    const { node: arriving } = await startUpload(db, env, editor.id, {
      parentId: hall.id,
      name: "arriving.bin",
      size: 10,
      multipart: true,
    });

    const nodes = {
      Hall: hall.id,
      "live.txt": live.id,
      "team-only.txt": privy.id,
      "Old (trashed)": old.id,
      "Old/inner.txt": inner.id,
      "Old/gone.txt (trashed)": gone.id,
      "binned.txt (trashed)": binned.id,
      "arriving.bin (uploading)": arriving.id,
    };

    /** Per node, the role of [owner, viewer, editor, anyone] under `trash`. */
    const table = async (trash: TrashPolicy) => {
      const out: Record<string, (DriveRole | null)[]> = {};

      for (const name of Object.keys(nodes)) {
        out[name] = [];
      }

      const reached = await Promise.all(
        people.map((person) =>
          reachAll(db, person.id, Object.values(nodes), trash)
        )
      );

      for (const all of reached) {
        const roles = new Map(all.map((r) => [r.node.id, r.role]));

        for (const [name, id] of Object.entries(nodes)) {
          defined(out[name]).push(roles.get(id) ?? null);
        }
      }

      return out;
    };

    const none = [null, null, null, null];
    const ownerOnly = ["owner", null, null, null];
    observed.push(
      await table("outside"),
      // The owner opens what they trashed, each node, even under a trashed folder; nobody else does.
      await table("own-trash"),
      // The Trash view: the tops of the owner's trashed subtrees only.
      await table("trash-view")
    );

    // One node at a time answers the same; a readable file is a whole file, never a folder or an upload.
    const foundReach = await reach(db, anyone.id, live.id, "outside");
    const file = await reachFile(db, viewer.id, live.id, "outside");
    const hallFile = await reachFile(db, owner.id, hall.id, "outside");

    const arrivingFile = await reachFile(
      db,
      owner.id,
      arriving.id,
      "own-trash"
    );

    const binnedOwn = await reachFile(db, owner.id, binned.id, "own-trash");
    const binnedOutside = await reachFile(db, owner.id, binned.id, "outside");
    observed.push({
      role: foundReach?.role,
      key: file?.key,
      reachFile: hallFile,
      reachFile2: arrivingFile,
      key2: binnedOwn?.key,
      reachFile3: binnedOutside,
    });
    // An upload is its uploader's, not the folder owner's.
    const upload = await runningUpload(db, editor.id, arriving.id);
    observed.push(
      {
        id: upload?.id,
        runningUpload: await runningUpload(db, owner.id, arriving.id),
        runningUpload2: await runningUpload(db, editor.id, live.id),
      },
      // Breadcrumbs start at the highest folder shared with the person.
      {
        crumbsMap: defined(
          await nodeDetails(db, anyone.id, live.id)
        ).crumbs.map((c) => c.name),
        crumbsMap2: defined(
          await nodeDetails(db, viewer.id, live.id)
        ).crumbs.map((c) => c.name),
      }
    );

    expect(observed).toStrictEqual([
      // table("outside")
      {
        Hall: ["owner", "viewer", "editor", "viewer"],
        "live.txt": ["owner", "viewer", "editor", "viewer"],
        "team-only.txt": ["owner", "viewer", "editor", null],
        "Old (trashed)": none,
        "Old/inner.txt": none,
        "Old/gone.txt (trashed)": none,
        "binned.txt (trashed)": none,
        "arriving.bin (uploading)": none,
      },
      // table("own-trash")
      {
        Hall: ["owner", "viewer", "editor", "viewer"],
        "live.txt": ["owner", "viewer", "editor", "viewer"],
        "team-only.txt": ["owner", "viewer", "editor", null],
        "Old (trashed)": ownerOnly,
        "Old/inner.txt": none,
        "Old/gone.txt (trashed)": ownerOnly,
        "binned.txt (trashed)": ownerOnly,
        "arriving.bin (uploading)": none,
      },
      // table("trash-view")
      {
        Hall: none,
        "live.txt": none,
        "team-only.txt": none,
        "Old (trashed)": ownerOnly,
        "Old/inner.txt": none,
        "Old/gone.txt (trashed)": none,
        "binned.txt (trashed)": ownerOnly,
        "arriving.bin (uploading)": none,
      },
      // { role: foundReach?.role, key: file?.key, reachFile: await reachFile(db, owner.id, hall...
      {
        role: "viewer",
        key: live.r2Key,
        reachFile: null,
        reachFile2: null,
        key2: binned.r2Key,
        reachFile3: null,
      },
      // { id: upload?.id, runningUpload: await runningUpload(db, owner.id, arriving.id), runnin...
      {
        id: arriving.id,
        runningUpload: null,
        runningUpload2: null,
      },
      // { crumbsMap: defined(await nodeDetails(db, anyone.id, live.id)).crumbs.map( (c) => c.na...
      { crumbsMap: ["Hall"], crumbsMap2: ["Team", "Hall"] },
    ]);
    // Everyone's Shared with me is the other cases' again.
    await removeShare(db, owner.id, hall.id, "everyone");
  });
});

describe("folders and files", () => {
  it("makes folders, files inside them, lists them with breadcrumbs and keeps names unique", async () => {
    const observed: unknown[] = [];

    const ann = await mailbox("drive-ann", "Ann");
    const docs = await createFolder(db, ann.id, null, " Docs ");
    observed.push({ name: docs.name, path: docs.path });
    const q4 = await createFolder(db, ann.id, docs.id, "Q4");
    observed.push(q4.path);

    const file = await putFile(
      ann.id,
      q4.id,
      "plan.txt",
      "the plan",
      "text/plain"
    );

    observed.push({
      status: file.status,
      fileSize: file.size,
      path: file.path,
      r2Key: file.r2Key,
    });

    const twin = await putFile(ann.id, q4.id, "plan.txt", "another");
    observed.push(twin.name);
    const again = await createFolder(db, ann.id, null, "docs");
    observed.push(again.name);

    const root = defined(await listFolder(db, ann.id, null, byName));
    observed.push({
      folder: root.folder,
      rowsMap: root.rows.map((r) => r.name),
    });
    const inQ4 = defined(await listFolder(db, ann.id, q4.id, byName));
    observed.push(
      {
        name: inQ4.folder?.name,
        role: inQ4.folder?.role,
        crumbs: inQ4.crumbs,
        rowsMap: inQ4.rows.map((r) => r.name),
        role2: defined(inQ4.rows[1]).role,
        name2: defined(inQ4.rows[1]).owner.name,
      },
      await storageUsed(db, ann.id),
      (await rejection(createFolder(db, ann.id, null, "   "))) instanceof
        DriveError,
      (await rejection(createFolder(db, ann.id, file.id, "x"))) instanceof
        DriveError
    );

    expect(observed).toStrictEqual([
      // { name: docs.name, path: docs.path }
      {
        name: "Docs",
        path: "/",
      },
      // q4.path
      `/${docs.id}/`,
      // { status: file.status, fileSize: file.size, path: file.path, r2Key: file.r2Key, }
      {
        status: "ready",
        fileSize: 8,
        path: `/${docs.id}/${q4.id}/`,
        r2Key: `drive/${ann.id}/${file.id}`,
      },
      // twin.name
      "plan (2).txt",
      // again.name
      "docs (2)",
      // { folder: root.folder, rowsMap: root.rows.map((r) => r.name), }
      { folder: null, rowsMap: ["Docs", "docs (2)"] },
      // { name: inQ4.folder?.name, role: inQ4.folder?.role, crumbs: inQ4.crumbs, rowsMap: inQ4....
      {
        name: "Q4",
        role: "owner",
        crumbs: [{ id: docs.id, name: "Docs" }],
        rowsMap: ["plan (2).txt", "plan.txt"],
        role2: "owner",
        name2: "Ann",
      },
      // storageUsed(db, ann.id)
      8 + 7,
      // (await rejection(createFolder(db, ann.id, null, " "))) instanceof DriveError
      true,
      // (await rejection(createFolder(db, ann.id, file.id, "x"))) instanceof DriveError
      true,
    ]);
  });

  it("makes a path of folders once and reuses it", async () => {
    const ann = await mailbox("drive-ann", "Ann");
    const base = await createFolder(db, ann.id, null, "Uploads");

    const leaf = await ensureFolderPath(db, ann.id, base.id, [
      "2026",
      "October",
    ]);

    const again = await ensureFolderPath(db, ann.id, base.id, [
      "2026",
      "october",
    ]);

    expect(leaf).toBe(again);
    const year = defined(await listFolder(db, ann.id, base.id, byName));
    expect(year.rows.map((r) => r.name)).toStrictEqual(["2026"]);
    expect(defined(await getNode(defined(leaf))).path).toBe(
      `/${base.id}/${defined(year.rows[0]).id}/`
    );
  });

  it("renames and moves, keeping every descendant's path, and never into itself", async () => {
    const observed: unknown[] = [];

    const bo = await mailbox("drive-bo", "Bo");
    const a = await createFolder(db, bo.id, null, "A");
    const b = await createFolder(db, bo.id, a.id, "B");
    const c = await createFolder(db, bo.id, b.id, "C");
    const f = await putFile(bo.id, c.id, "deep.txt", "deep");
    const { name } = await renameNode(db, bo.id, f.id, "deeper.txt");
    observed.push(
      name,
      (await rejection(renameNode(db, bo.id, f.id, ""))) instanceof DriveError,
      // B (with C and the file) to the root.
      {
        moveNodes: await moveNodes(db, bo.id, [b.id], null),
        path: defined(await getNode(b.id)).path,
        path2: defined(await getNode(c.id)).path,
        path3: defined(await getNode(f.id)).path,
      },
      // Already there: nothing to do.
      await moveNodes(db, bo.id, [b.id], null),
      // Into its own child: refused.
      await rejectionIncludes(
        moveNodes(db, bo.id, [b.id], c.id),
        "into itself"
      ),
      await rejectionIncludes(
        moveNodes(db, bo.id, [b.id], b.id),
        "into itself"
      ),
      // Into a file: refused.
      (await rejection(moveNodes(db, bo.id, [a.id], f.id))) instanceof
        DriveError
    );
    // A name taken in the target gets a suffix.
    const other = await createFolder(db, bo.id, a.id, "deeper.txt");
    observed.push(other.name);
    await moveNodes(db, bo.id, [f.id], a.id);
    observed.push({
      name: defined(await getNode(f.id)).name,
      path: defined(await getNode(f.id)).path,
    });

    expect(observed).toStrictEqual([
      // name
      "deeper.txt",
      // (await rejection(renameNode(db, bo.id, f.id, ""))) instanceof DriveError
      true,
      // { moveNodes: await moveNodes(db, bo.id, [b.id], null), path: defined(await getNode(b.id...
      {
        moveNodes: 1,
        path: "/",
        path2: `/${b.id}/`,
        path3: `/${b.id}/${c.id}/`,
      },
      // moveNodes(db, bo.id, [b.id], null)
      0,
      // (await rejection(moveNodes(db, bo.id, [b.id], c.id)))?.message.includes("into itself")
      true,
      // (await rejection(moveNodes(db, bo.id, [b.id], b.id)))?.message.includes("into itself")
      true,
      // (await rejection(moveNodes(db, bo.id, [a.id], f.id))) instanceof DriveError
      true,
      // other.name
      "deeper.txt",
      // { name: defined(await getNode(f.id)).name, path: defined(await getNode(f.id)).path, }
      { name: "deeper (2).txt", path: `/${a.id}/` },
    ]);
  });
});

describe("trash", () => {
  it("hides a trashed folder's subtree, lists only its top, restores it, and deletes forever from the trash alone", async () => {
    const observed: unknown[] = [];

    const cy = await mailbox("drive-cy", "Cy");
    const top = await createFolder(db, cy.id, null, "Top");
    const inner = await createFolder(db, cy.id, top.id, "Inner");
    const f = await putFile(cy.id, inner.id, "gone.txt", "bye");
    const loose = await putFile(cy.id, null, "loose.txt", "loose");

    observed.push({
      trashNodes: await trashNodes(db, cy.id, [top.id]),
      rowsMap: defined(await listFolder(db, cy.id, null, byName)).rows.map(
        (r) => r.name
      ),
      listFolder: await listFolder(db, cy.id, inner.id, byName),
    });
    const got2 = await listView(db, cy.id, { search: "gone" }, byName);
    observed.push(got2.length);
    const view = await listView(db, cy.id, "trash", byName);
    observed.push(
      view.map((r) => r.name),
      // Not from the trash: nothing is deleted.
      await deleteForever(env, db, cy.id, [loose.id])
    );
    const got3 = await getNode(loose.id);
    const restoredTop = await restoreNodes(db, cy.id, [top.id]);
    const restoredReach = await reach(db, cy.id, f.id, "outside");
    observed.push(got3 === null, {
      restoreNodes: restoredTop,
      role: restoredReach?.role,
    });

    // The inner folder trashed, then its parent: restoring the inner one alone puts it at the root.
    await trashNodes(db, cy.id, [inner.id]);
    await trashNodes(db, cy.id, [top.id]);
    const view2 = await listView(db, cy.id, "trash", byName);
    observed.push({
      listViewMap: view2.map((r) => r.name),
      restoreNodes: await restoreNodes(db, cy.id, [inner.id]),
    });
    const restored = defined(await getNode(inner.id));
    observed.push({
      parentId: restored.parentId,
      path: restored.path,
      path2: defined(await getNode(f.id)).path,
    });

    // Deleting the trashed Top for good removes its rows and objects, and leaves the restored Inner alone.
    await trashNodes(db, cy.id, [loose.id]);
    observed.push({
      deleteForever: await deleteForever(env, db, cy.id, [top.id, loose.id]),
      getNode: await getNode(top.id),
      getNode2: await getNode(loose.id),
      head: await env.DRIVE.head(defined(loose.r2Key)),
    });
    const got4 = await getNode(inner.id);
    observed.push(got4 === null);
    const got5 = await env.DRIVE.head(defined(f.r2Key));
    observed.push(got5 === null);

    await trashNodes(db, cy.id, [inner.id]);
    observed.push({
      emptyTrash: await emptyTrash(env, db, cy.id),
      getNode: await getNode(f.id),
      head: await env.DRIVE.head(defined(f.r2Key)),
      storageUsed: await storageUsed(db, cy.id),
    });

    expect(observed).toStrictEqual([
      // { trashNodes: await trashNodes(db, cy.id, [top.id]), rowsMap: defined(await listFolder(...
      {
        trashNodes: [top.id],
        rowsMap: ["loose.txt"],
        listFolder: null,
      },
      // got2.length
      0,
      // view.map((r) => r.name)
      ["Top"],
      // deleteForever(env, db, cy.id, [loose.id])
      0,
      // got3 === null
      false,
      // { restoreNodes: await restoreNodes(db, cy.id, [top.id]), role: (await reach(db, cy.id, ...
      { restoreNodes: 1, role: "owner" },
      // { listViewMap: view2.map((r) => r.name), restoreNodes: await restoreNodes(db, cy.id, [i...
      { listViewMap: ["Top"], restoreNodes: 1 },
      // { parentId: restored.parentId, path: restored.path, path2: defined(await getNode(f.id))...
      { parentId: null, path: "/", path2: `/${inner.id}/` },
      // { deleteForever: await deleteForever(env, db, cy.id, [top.id, loose.id]), getNode: awai...
      {
        deleteForever: 2,
        getNode: null,
        getNode2: null,
        head: null,
      },
      // got4 === null
      false,
      // got5 === null
      false,
      // { emptyTrash: await emptyTrash(env, db, cy.id), getNode: await getNode(f.id), head: awa...
      {
        emptyTrash: 1,
        getNode: null,
        head: null,
        storageUsed: 0,
      },
    ]);
  });

  it("prunes what has been in the trash for 30 days and abandons a stale upload", async () => {
    const observed: unknown[] = [];

    const di = await mailbox("drive-di", "Di");
    const old = await putFile(di.id, null, "old.txt", "old");
    const fresh = await putFile(di.id, null, "fresh.txt", "fresh");
    await trashNodes(db, di.id, [old.id, fresh.id]);
    await db
      .update(driveNodes)
      .set({ trashedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() })
      .where(eq(driveNodes.id, old.id));

    const { node: stale } = await startUpload(db, env, di.id, {
      parentId: null,
      name: "stale.bin",
      size: 10,
      multipart: true,
    });

    await db
      .update(driveNodes)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .where(eq(driveNodes.id, stale.id));

    const { node: running } = await startUpload(db, env, di.id, {
      parentId: null,
      name: "running.bin",
      size: 10,
      multipart: true,
    });

    observed.push({
      pruneDrive: await pruneDrive(env, db, di.id),
      getNode: await getNode(old.id),
    });
    const got6 = await getNode(fresh.id);
    observed.push(got6 === null, await getNode(stale.id));
    const got7 = await getNode(running.id);
    observed.push(
      got7 === null,
      // A file still arriving is not listed anywhere.
      defined(await listFolder(db, di.id, null, byName)).rows.map((r) => r.name)
    );
    await abortUpload(env, db, di.id, running.id);
    observed.push(await getNode(running.id));

    expect(observed).toStrictEqual([
      // { pruneDrive: await pruneDrive(env, db, di.id), getNode: await getNode(old.id), }
      {
        pruneDrive: {
          deleted: 1,
          abandoned: 1,
        },
        getNode: null,
      },
      // got6 === null
      false,
      // getNode(stale.id)
      null,
      // got7 === null
      false,
      // defined(await listFolder(db, di.id, null, byName)).rows.map((r) => r.name)
      [],
      // getNode(running.id)
      null,
    ]);
  });
});

describe("uploads in parts", () => {
  it("opens a multipart upload, takes parts and completes it with the size the bucket holds", async () => {
    const observed: unknown[] = [];

    const ed = await mailbox("drive-ed", "Ed");

    const { node, uploadId } = await startUpload(db, env, ed.id, {
      parentId: null,
      name: "big.bin",
      size: 3000,
      contentType: "application/octet-stream",
      multipart: true,
    });

    observed.push({ uploadId: Boolean(uploadId), status: node.status });

    const part = await uploadPart(
      env,
      db,
      ed.id,
      node.id,
      1,
      new Uint8Array(3000).fill(7).buffer
    );

    observed.push(part.partNumber);
    const done = await finishUpload(env, db, ed.id, node.id, [part]);
    const doneHead = await env.DRIVE.head(defined(done.r2Key));
    observed.push(
      {
        status: done.status,
        doneSize: done.size,
        uploadId: done.uploadId,
        headSize: doneHead?.size,
      },
      (await rejection(
        finishUpload(env, db, ed.id, node.id, [part])
      )) instanceof DriveError
    );
    // Someone else cannot take over an upload.
    const fay = await mailbox("drive-fay", "Fay");

    const { node: other } = await startUpload(db, env, ed.id, {
      parentId: null,
      name: "other.bin",
      size: 1,
      multipart: true,
    });

    observed.push(
      (await rejection(
        uploadPart(env, db, fay.id, other.id, 1, new ArrayBuffer(1))
      )) instanceof DriveError,
      await rejectionIncludes(
        startUpload(db, env, ed.id, {
          parentId: null,
          name: "huge.bin",
          size: 6 * 1024 * 1024 * 1024,
          multipart: true,
        }),
        "5 GB"
      )
    );

    expect(observed).toStrictEqual([
      // { uploadId: Boolean(uploadId), status: node.status }
      {
        uploadId: true,
        status: "uploading",
      },
      // part.partNumber
      1,
      // { status: done.status, doneSize: done.size, uploadId: done.uploadId, headSize: (await e...
      {
        status: "ready",
        doneSize: 3000,
        uploadId: null,
        headSize: 3000,
      },
      // (await rejection(finishUpload(env, db, ed.id, node.id, [part]))) instanceof DriveError
      true,
      // (await rejection(uploadPart(env, db, fay.id, other.id, 1, new ArrayBuffer(1)))) instanc...
      true,
      // (await rejection(startUpload(db, env, ed.id, { parentId: null, name: "huge.bin", size: ...
      true,
    ]);
  });
});

describe("sharing", () => {
  it("lets a viewer read and an editor add within a shared folder, and nobody beyond it", async () => {
    const observed: unknown[] = [];

    const gil = await mailbox("drive-gil", "Gil");
    const hal = await mailbox("drive-hal", "Hal");
    const ivy = await mailbox("drive-ivy", "Ivy");
    const team = await createFolder(db, gil.id, null, "Team");
    const sub = await createFolder(db, gil.id, team.id, "Sub");
    const f = await putFile(gil.id, sub.id, "shared.txt", "hello team");
    // In Gil's own root, shared with nobody: no search of Hal's finds it.
    await putFile(gil.id, null, "secret.txt", "mine");

    const got8 = await listView(db, hal.id, "shared", byName);
    observed.push(
      got8.length,
      (await rejection(
        setShare(db, hal.id, team.id, ivy.id, "viewer")
      )) instanceof DriveError,
      (await rejection(
        setShare(db, gil.id, team.id, gil.id, "viewer")
      )) instanceof DriveError,
      (await rejection(
        setShare(db, gil.id, team.id, "usr_nobody", "viewer")
      )) instanceof DriveError
    );

    await setShare(db, gil.id, team.id, hal.id, "viewer");
    const view = await listView(db, hal.id, "shared", byName);
    observed.push(view.map((r) => [r.name, r.role, r.owner.name]));
    const details = defined(await nodeDetails(db, hal.id, f.id));
    // Hal's breadcrumbs start at what was shared, not at Gil's root.
    observed.push(details.crumbs);
    const listing = defined(await listFolder(db, hal.id, sub.id, byName));
    observed.push(
      {
        role: listing.folder?.role,
        rowsMap: listing.rows.map((r) => r.name),
      },
      await rejectionIncludes(
        createFolder(db, hal.id, sub.id, "Mine"),
        "only view"
      ),
      await rejectionIncludes(
        renameNode(db, hal.id, f.id, "x.txt"),
        "only view"
      ),
      await rejectionIncludes(trashNodes(db, hal.id, [f.id]), "only view")
    );
    const view2 = await listView(db, hal.id, { search: "shared" }, byName);
    observed.push(view2.map((r) => r.name));
    const got9 = await listView(db, hal.id, { search: "secret" }, byName);
    observed.push(got9.length);
    // Shared with everyone, it is under Ivy's Shared with me too.
    await setShare(db, gil.id, team.id, "everyone", "viewer");
    const view3 = await listView(db, ivy.id, "shared", byName);
    observed.push(view3.map((r) => r.name));
    // Gil's own listing does not show Team under "Shared with me", only the marker.
    const got10 = await listView(db, gil.id, "shared", byName);
    observed.push(
      got10.length,
      Boolean(
        defined(await listFolder(db, gil.id, null, byName)).rows.find(
          (r) => r.id === team.id
        )?.shared
      )
    );

    // Hal becomes an editor: can add a file (owned by Gil, made by Hal), rename and move within Team.
    await setShare(db, gil.id, team.id, hal.id, "editor");
    const shares = await listShares(db, gil.id, team.id);
    observed.push(
      shares.map((s) => [s.subject, s.role, s.person?.name ?? null])
    );
    const added = await putFile(hal.id, sub.id, "from-hal.txt", "by hal");
    const halRecent = await listView(db, hal.id, "recent", byName);
    observed.push(
      {
        userId: added.userId,
        createdBy: added.createdBy,
        rowsMap: defined(await listFolder(db, gil.id, sub.id, byName)).rows.map(
          (r) => r.name
        ),
        listViewMap: halRecent.map((r) => r.name),
        storageUsed: await storageUsed(db, hal.id),
        moveNodes: await moveNodes(db, hal.id, [added.id], team.id),
      },
      await rejectionIncludes(
        moveNodes(db, hal.id, [added.id], null),
        "within the drive"
      )
    );
    const targets = await moveTargets(db, hal.id, [added.id]);
    const halTrashed = await trashNodes(db, hal.id, [added.id]);
    const gilTrash = await listView(db, gil.id, "trash", byName);
    observed.push(
      Boolean(targets.root),
      // By name; Team's parent is Gil's root, not Hal's to see, so it sits at the top.
      targets.folders.map((folder) => [folder.name, folder.parentId]),
      // Hal trashes it: it lands in Gil's trash.
      {
        trashNodes: halTrashed,
        listViewMap: gilTrash.map((r) => r.name),
      }
    );
    const got11 = await listView(db, hal.id, "trash", byName);

    const halListShares = await rejectionIncludes(
      listShares(db, hal.id, team.id),
      "owner"
    );

    const halDeleted = await deleteForever(env, db, hal.id, [added.id]);
    const halStarred = await setStar(db, hal.id, [f.id], true);
    const halStarredView = await listView(db, hal.id, "starred", byName);
    observed.push(
      got11.length,
      // Hal cannot share or delete forever.
      halListShares,
      halDeleted,
      // Stars are the reader's own.
      {
        setStar: halStarred,
        listViewMap: halStarredView.map((r) => r.name),
      }
    );
    const got12 = await listView(db, gil.id, "starred", byName);
    observed.push(
      got12.length,
      Boolean(defined(await reach(db, hal.id, f.id, "outside")).starred)
    );
    await setStar(db, hal.id, [f.id], false);
    const got13 = await listView(db, hal.id, "starred", byName);
    observed.push(got13.length);

    // Unsharing takes it all away again, and a trashed shared folder is gone for the others too.
    await removeShare(db, gil.id, team.id, hal.id);
    await removeShare(db, gil.id, team.id, "everyone");
    observed.push({
      reach: await reach(db, hal.id, f.id, "outside"),
      reach2: await reach(db, ivy.id, f.id, "outside"),
    });
    await setShare(db, gil.id, team.id, hal.id, "viewer");
    await trashNodes(db, gil.id, [team.id]);
    const got14 = await listView(db, hal.id, "shared", byName);
    observed.push(got14.length);

    const people = await colleagues(db, gil.id);
    observed.push({
      some: people.some((p) => p.id === gil.id),
      some2: people.some((p) => p.id === hal.id),
    });

    expect(observed).toStrictEqual([
      // got8.length
      0,
      // (await rejection(setShare(db, hal.id, team.id, ivy.id, "viewer"))) instanceof DriveError
      true,
      // (await rejection(setShare(db, gil.id, team.id, gil.id, "viewer"))) instanceof DriveError
      true,
      // (await rejection(setShare(db, gil.id, team.id, "usr_nobody", "viewer"))) instanceof Dri...
      true,
      // view.map((r) => [r.name, r.role, r.owner.name])
      [["Team", "viewer", "Gil"]],
      // details.crumbs
      [
        { id: team.id, name: "Team" },
        { id: sub.id, name: "Sub" },
      ],
      // { role: listing.folder?.role, rowsMap: listing.rows.map((r) => r.name), }
      { role: "viewer", rowsMap: ["shared.txt"] },
      // (await rejection(createFolder(db, hal.id, sub.id, "Mine")))?.message.includes("only view")
      true,
      // (await rejection(renameNode(db, hal.id, f.id, "x.txt")))?.message.includes("only view")
      true,
      // (await rejection(trashNodes(db, hal.id, [f.id])))?.message.includes("only view")
      true,
      // view2.map((r) => r.name)
      ["shared.txt"],
      // got9.length
      0,
      // view3.map((r) => r.name)
      ["Team"],
      // got10.length
      0,
      // Boolean(defined(await listFolder(db, gil.id, null, byName)).rows.find( (r) => r.id === ...
      true,
      // shares.map((s) => [s.subject, s.role, s.person?.name ?? null])
      [
        [hal.id, "editor", "Hal"],
        ["everyone", "viewer", null],
      ],
      // { userId: added.userId, createdBy: added.createdBy, rowsMap: defined(await listFolder(d...
      {
        userId: gil.id,
        createdBy: hal.id,
        rowsMap: ["from-hal.txt", "shared.txt"],
        listViewMap: ["from-hal.txt"],
        storageUsed: 0,
        moveNodes: 1,
      },
      // (await rejection(moveNodes(db, hal.id, [added.id], null)))?.message.includes("within th...
      true,
      // Boolean(targets.root)
      false,
      // targets.folders.map((folder) => [folder.name, folder.parentId])
      [
        ["Sub", team.id],
        ["Team", null],
      ],
      // { trashNodes: await trashNodes(db, hal.id, [added.id]), listViewMap: (await listView(db...
      { trashNodes: [added.id], listViewMap: ["from-hal.txt"] },
      // got11.length
      0,
      // (await rejection(listShares(db, hal.id, team.id)))?.message.includes("owner")
      true,
      // deleteForever(env, db, hal.id, [added.id])
      0,
      // { setStar: await setStar(db, hal.id, [f.id], true), listViewMap: (await listView(db, ha...
      { setStar: 1, listViewMap: ["shared.txt"] },
      // got12.length
      0,
      // Boolean(defined(await reach(db, hal.id, f.id, "outside")).starred)
      true,
      // got13.length
      0,
      // { reach: await reach(db, hal.id, f.id, "outside"), reach2: await reach(db, ivy.id, f.id...
      { reach: null, reach2: null },
      // got14.length
      0,
      // { some: people.some((p) => p.id === gil.id), some2: people.some((p) => p.id === hal.id), }
      { some: false, some2: true },
    ]);
  });
});

describe("many shares", () => {
  it("searches under and moves into every folder shared with the person, past 40", async () => {
    const lu = await mailbox("drive-lu", "Lu");
    const mo = await mailbox("drive-mo", "Mo");
    const folders: string[] = [];

    const shareProject = async (i: number) => {
      const folder = await createFolder(db, lu.id, null, `Project ${i}`);
      await putFile(lu.id, folder.id, `brief ${i}.txt`, "x");
      await setShare(db, lu.id, folder.id, mo.id, "editor");

      return folder.id;
    };

    for (let i = 1; i <= 45; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- D1 and R2 writes, one project at a time, in the order of the numbers in their names
      folders.push(await shareProject(i));
    }

    await expect(
      listView(db, mo.id, { search: "brief" }, byName)
    ).resolves.toHaveLength(45);

    const last = defined(
      defined(await listFolder(db, mo.id, defined(folders[44]), byName)).rows[0]
    );

    const targets = await moveTargets(db, mo.id, [last.id]);
    expect(sorted(targets.folders.map((f) => f.id))).toStrictEqual(
      sorted(folders)
    );
  });
});

describe("search", () => {
  it("matches every word in a name and treats % and _ as letters", async () => {
    const jo = await mailbox("drive-jo", "Jo");
    await putFile(jo.id, null, "Budget 2026 final.xlsx", "x");
    await putFile(jo.id, null, "100%_done.txt", "y");
    const view = await listView(db, jo.id, { search: "2026 budget" }, byName);
    expect(view.map((r) => r.name)).toStrictEqual(["Budget 2026 final.xlsx"]);
    const view2 = await listView(db, jo.id, { search: "%_" }, byName);
    expect(view2.map((r) => r.name)).toStrictEqual(["100%_done.txt"]);
    const view3 = await listView(db, jo.id, { search: "%" }, byName);
    expect(view3.map((r) => r.name)).toStrictEqual(["100%_done.txt"]);
    await expect(
      listView(db, jo.id, { search: "   " }, byName)
    ).resolves.toHaveLength(0);
  });
});
