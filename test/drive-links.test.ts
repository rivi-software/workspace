import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { driveLinks, users } from "~/db/schema";
import { openLink, reachAllByLink } from "~/lib/drive/access.server";
import type { LinkAccess } from "~/lib/drive/access.server";
import {
  DriveError,
  createFolder,
  deleteForever,
  finishUpload,
  listFolder,
  removeShare,
  setShare,
  startUpload,
  trashNodes,
} from "~/lib/drive/drive.server";
import {
  createExternalShare,
  linkVisits,
  listExternalShares,
  passCookie,
  readPasses,
  revokeExternalShare,
  sharedFileResponse,
  sharedPage,
  sharedPagePost,
} from "~/lib/drive/links.server";
import type { NewExternalShare } from "~/lib/drive/links.server";
import { confirmCode, sendCode } from "~/lib/drive/visitor.server";
import { setExternalSharing } from "~/lib/workspace-settings.server";

import {
  db,
  defined,
  mailbox,
  recordingEmail,
  rejection,
  rejectionMatches,
} from "./fixtures";

const HOUR = 3_600_000;

/** A small file, sent whole, as the upload route does it. */
const putFile = async (
  userId: string,
  parentId: string | null,
  name: string,
  text: string
) => {
  const bytes = new TextEncoder().encode(text);

  const { node } = await startUpload(db, env, userId, {
    parentId,
    name,
    size: bytes.byteLength,
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes, {
    httpMetadata: { contentType: node.contentType },
  });

  return finishUpload(env, db, userId, node.id);
};

/** A link and its token, made as the share dialog makes it (`link` defaults: 30 days, downloads allowed). */
const linkTo = async (
  user: { id: string; name: string },
  nodeId: string,
  input: Partial<NewExternalShare> = {},
  at?: number
) => {
  const { link, url } = await createExternalShare(
    env,
    db,
    user,
    nodeId,
    { kind: "link", allowDownload: true, ...input },
    at
  );

  return { link, token: defined(url.split("/s/")[1]) };
};

let ips = 0;

/** A request from a client of its own, so one test's throttle never holds another's. */
const visitor = (path = "/s/x", init: RequestInit = {}) => {
  const headers = new Headers(init.headers);

  if (!headers.has("cf-connecting-ip")) {
    ips += 1;
    headers.set("cf-connecting-ip", `203.0.113.${ips % 250}`);
  }

  return new Request(`${env.APP_URL}${path}`, { ...init, headers });
};

const stateOf = (access: LinkAccess | null) => access?.state ?? null;

describe("the gate for links outside the workspace", () => {
  it("opens a link only to its live, whole subtree, and never past an expiry, a revocation or a password", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("lk-owner", "Lin Owner");
    const shared = await createFolder(db, owner.id, null, "Shared");
    const doc = await putFile(owner.id, shared.id, "doc.txt", "doc");
    const inner = await createFolder(db, owner.id, shared.id, "Inner");
    const deep = await putFile(owner.id, inner.id, "deep.txt", "deep");
    const old = await createFolder(db, owner.id, shared.id, "Old");
    const buried = await putFile(owner.id, old.id, "buried.txt", "buried");
    const binned = await putFile(owner.id, shared.id, "binned.txt", "binned");

    const { node: arriving } = await startUpload(db, env, owner.id, {
      parentId: shared.id,
      name: "arriving.bin",
      size: 10,
      multipart: true,
    });

    const privy = await createFolder(db, owner.id, null, "Private");
    const secret = await putFile(owner.id, privy.id, "secret.txt", "secret");

    const at = Date.now();
    const folder = await linkTo(owner, shared.id);
    const file = await linkTo(owner, doc.id);
    const locked = await linkTo(owner, shared.id, { password: "open sesame" });

    const expiring = await linkTo(owner, doc.id, {
      expiresAt: new Date(at + HOUR).toISOString(),
    });

    const revoked = await linkTo(owner, doc.id);
    const onBinned = await linkTo(owner, binned.id);
    const onBuried = await linkTo(owner, buried.id);
    await revokeExternalShare(db, owner.id, revoked.link.id);
    await trashNodes(db, owner.id, [old.id, binned.id]);
    // A file still uploading is nobody's: no link can be made to it.
    observed.push(
      (await rejection(linkTo(owner, arriving.id))) instanceof DriveError,
      // Per link, what the token opens.
      {
        value: {
          "live folder": stateOf(await openLink(db, folder.token)),
          "live file": stateOf(await openLink(db, file.token)),
          "trashed file": stateOf(await openLink(db, onBinned.token)),
          "trashed ancestor": stateOf(await openLink(db, onBuried.token)),
          "expired link": stateOf(
            await openLink(db, expiring.token, {}, at + 2 * HOUR)
          ),
          "revoked link": stateOf(await openLink(db, revoked.token)),
          "no password": stateOf(await openLink(db, locked.token)),
          "wrong password": stateOf(
            await openLink(db, locked.token, { password: "guess" })
          ),
          "right password": stateOf(
            await openLink(db, locked.token, { password: "open sesame" })
          ),
          "a pass": stateOf(
            await openLink(db, locked.token, {
              passes: new Set([locked.link.id]),
            })
          ),
          "another link's pass": stateOf(
            await openLink(db, locked.token, {
              passes: new Set([folder.link.id]),
            })
          ),
          "no such token": stateOf(await openLink(db, "not-a-token")),
        },
        stateOf: stateOf(await openLink(db, expiring.token, {}, at + HOUR / 2)),
      }
    );
    const wrong = await openLink(db, locked.token, { password: "guess" });
    observed.push(Boolean(wrong?.state === "password" && wrong.wrong));

    // Per node, what the folder's link and the file's link reach.
    const nodes = {
      Shared: shared.id,
      "doc.txt": doc.id,
      "Inner/deep.txt": deep.id,
      "Old (trashed)": old.id,
      "Old/buried.txt": buried.id,
      "binned.txt (trashed)": binned.id,
      "arriving.bin (uploading)": arriving.id,
      "Private/secret.txt": secret.id,
    };

    const table = async (token: string) => {
      const access = await openLink(db, token);

      if (access?.state !== "open") {
        throw new Error("the link does not open");
      }

      const reachAll = await reachAllByLink(
        db,
        access.open,
        Object.values(nodes)
      );

      const reached = new Map(reachAll.map((r) => [r.node.id, r.role]));

      return Object.fromEntries(
        Object.entries(nodes).map(([name, id]) => [
          name,
          reached.get(id) ?? null,
        ])
      );
    };

    observed.push({
      table: await table(folder.token),
      table2: await table(file.token),
    });

    // Restoring brings a trashed node's link back; deleting it for good takes the link with it.
    await trashNodes(db, owner.id, [shared.id]);
    observed.push({
      openLink: await openLink(db, folder.token),
      openLink2: await openLink(db, file.token),
    });
    await deleteForever(env, db, owner.id, [shared.id]);
    observed.push({
      openLink: await openLink(db, folder.token),
      driveLinksFindFirst: await db.query.driveLinks.findFirst({
        where: eq(driveLinks.id, folder.link.id),
      }),
    });

    expect(observed).toStrictEqual([
      // (await rejection(linkTo(owner, arriving.id))) instanceof DriveError
      true,
      // { value: { "live folder": stateOf(await openLink(db, folder.token)), "live file": state...
      {
        value: {
          "live folder": "open",
          "live file": "open",
          "trashed file": null,
          "trashed ancestor": null,
          "expired link": null,
          "revoked link": null,
          "no password": "password",
          "wrong password": "password",
          "right password": "open",
          "a pass": "open",
          "another link's pass": "password",
          "no such token": null,
        },
        stateOf: "open",
      },
      // Boolean(wrong?.state === "password" && wrong.wrong)
      true,
      // { table: await table(folder.token), table2: await table(file.token), }
      {
        table: {
          Shared: "viewer",
          "doc.txt": "viewer",
          "Inner/deep.txt": "viewer",
          "Old (trashed)": null,
          "Old/buried.txt": null,
          "binned.txt (trashed)": null,
          "arriving.bin (uploading)": null,
          "Private/secret.txt": null,
        },
        table2: {
          Shared: null,
          "doc.txt": "viewer",
          "Inner/deep.txt": null,
          "Old (trashed)": null,
          "Old/buried.txt": null,
          "binned.txt (trashed)": null,
          "arriving.bin (uploading)": null,
          "Private/secret.txt": null,
        },
      },
      // { openLink: await openLink(db, folder.token), openLink2: await openLink(db, file.token), }
      { openLink: null, openLink2: null },
      // { openLink: await openLink(db, folder.token), driveLinksFindFirst: await db.query.drive...
      { openLink: null, driveLinksFindFirst: undefined },
    ]);
  });

  it("stops a link when its creator loses access, is deactivated, or an admin turns sharing off", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("lk-own2", "Owner Two");
    const admin = await mailbox("lk-admin", "Admin");
    const viewer = await mailbox("lk-view2", "Vera Viewer");
    const team = await createFolder(db, owner.id, null, "Team");
    const plan = await putFile(owner.id, team.id, "plan.txt", "plan");
    await setShare(db, owner.id, team.id, viewer.id, "viewer");
    // A viewer may share outside too; the link only ever views.
    const theirs = await linkTo(viewer, plan.id);
    observed.push(stateOf(await openLink(db, theirs.token)));

    await removeShare(db, owner.id, team.id, viewer.id);
    observed.push(await openLink(db, theirs.token));
    await setShare(db, owner.id, team.id, viewer.id, "viewer");
    observed.push(stateOf(await openLink(db, theirs.token)));

    await db
      .update(users)
      .set({ active: false })
      .where(eq(users.id, viewer.id));
    observed.push(await openLink(db, theirs.token));
    await db.update(users).set({ active: true }).where(eq(users.id, viewer.id));

    await setExternalSharing(db, admin.id, false);

    try {
      await expect(openLink(db, theirs.token)).resolves.toBeNull();
      await expect(linkTo(owner, plan.id)).rejects.toThrow(/turned off/u);

      // Off is not deleted: the marker goes, the row stays.
      const listing = await listFolder(db, owner.id, team.id, {
        sort: "name",
        dir: "asc",
      });

      expect(
        defined(defined(listing).rows.find((r) => r.id === plan.id)).linked
      ).toBeFalsy();
    } finally {
      await setExternalSharing(db, admin.id, true);
    }

    observed.push(stateOf(await openLink(db, theirs.token)));

    expect(observed).toStrictEqual([
      // stateOf(await openLink(db, theirs.token))
      "open",
      // openLink(db, theirs.token)
      null,
      // stateOf(await openLink(db, theirs.token))
      "open",
      // openLink(db, theirs.token)
      null,
      // stateOf(await openLink(db, theirs.token))
      "open",
    ]);
  });
});

describe("making and revoking links", () => {
  it("marks a linked node, shows its address to its creator and the owner, and lets only them revoke it", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("lk-own3", "Owner Three");
    const editor = await mailbox("lk-edit3", "Eddie Editor");
    const viewer = await mailbox("lk-view3", "Val Viewer");
    const folder = await createFolder(db, owner.id, null, "Board");

    const minutes = await putFile(
      owner.id,
      folder.id,
      "minutes.txt",
      "minutes"
    );

    await setShare(db, owner.id, folder.id, editor.id, "editor");
    await setShare(db, owner.id, folder.id, viewer.id, "viewer");

    const byEditor = await linkTo(editor, minutes.id);
    const byOwner = await linkTo(owner, minutes.id, { allowDownload: false });

    const { rows } = defined(
      await listFolder(db, viewer.id, folder.id, {
        sort: "name",
        dir: "asc",
      })
    );

    observed.push(
      Boolean(defined(rows.find((r) => r.id === minutes.id)).linked)
    );

    const seen = await listExternalShares(env, db, viewer.id, minutes.id);
    observed.push({
      owner: seen.owner,
      canCreate: seen.canCreate,
      linksMap: seen.links.map((l) => [l.createdBy.name, l.url, l.canRevoke]),
    });
    const asOwner = await listExternalShares(env, db, owner.id, minutes.id);
    observed.push(
      {
        every: asOwner.links.every((l) =>
          l.url?.startsWith(`${env.APP_URL}/s/`)
        ),
        url: defined(asOwner.links.find((l) => l.id === byEditor.link.id)).url,
      },
      (await rejection(
        revokeExternalShare(db, viewer.id, byOwner.link.id)
      )) instanceof DriveError,
      (await rejection(
        revokeExternalShare(db, editor.id, byOwner.link.id)
      )) instanceof DriveError
    );
    // The owner stops anyone's link on their node; who and when stay on record.
    await revokeExternalShare(db, owner.id, byEditor.link.id);
    await revokeExternalShare(db, owner.id, byOwner.link.id);

    const record = await db.query.driveLinks.findFirst({
      where: eq(driveLinks.id, byEditor.link.id),
    });

    expect(record).toMatchObject({ createdBy: editor.id, revokedBy: owner.id });
    observed.push({
      revokedAt: Boolean(defined(record).revokedAt),
      openLink: await openLink(db, byEditor.token),
    });

    const after = defined(
      await listFolder(db, viewer.id, folder.id, {
        sort: "name",
        dir: "asc",
      })
    );

    observed.push(
      Boolean(defined(after.rows.find((r) => r.id === minutes.id)).linked),
      await rejectionMatches(
        revokeExternalShare(db, owner.id, byOwner.link.id),
        /ended/u
      )
    );

    expect(observed).toStrictEqual([
      // Boolean(defined(rows.find((r) => r.id === minutes.id)).linked)
      true,
      // { owner: seen.owner, canCreate: seen.canCreate, linksMap: seen.links.map((l) => [l.crea...
      {
        owner: false,
        canCreate: true,
        linksMap: [
          ["Owner Three", null, false],
          ["Eddie Editor", null, false],
        ],
      },
      // { every: asOwner.links.every((l) => l.url?.startsWith(`${env.APP_URL}/s/`)), url: defin...
      {
        every: true,
        url: `${env.APP_URL}/s/${byEditor.token}`,
      },
      // (await rejection(revokeExternalShare(db, viewer.id, byOwner.link.id))) instanceof Drive...
      true,
      // (await rejection(revokeExternalShare(db, editor.id, byOwner.link.id))) instanceof Drive...
      true,
      // { revokedAt: Boolean(defined(record).revokedAt), openLink: await openLink(db, byEditor....
      { revokedAt: true, openLink: null },
      // Boolean(defined(after.rows.find((r) => r.id === minutes.id)).linked)
      false,
      // /ended/u.test((await rejection(revokeExternalShare(db, owner.id, byOwner.link.id)))?.me...
      true,
    ]);
  });

  it("defaults to 30 days, takes no end or a future one, and checks a password's length", async () => {
    const owner = await mailbox("lk-own4");
    const file = await putFile(owner.id, null, "dates.txt", "dates");
    const at = Date.now();
    const plain = await linkTo(owner, file.id, {}, at);
    expect(Date.parse(defined(plain.link.expiresAt)) - at).toBe(30 * 24 * HOUR);
    const { link } = await linkTo(owner, file.id, { expiresAt: null });
    expect(link.expiresAt).toBeNull();
    await expect(
      linkTo(owner, file.id, { expiresAt: new Date(at - HOUR).toISOString() })
    ).rejects.toThrow(/future/u);
    await expect(linkTo(owner, file.id, { password: "abc" })).rejects.toThrow(
      /at least/u
    );
  });
});

describe("the public page and its file route", () => {
  it("lists a shared folder with breadcrumbs from its root, and nothing outside it", async () => {
    const owner = await mailbox("lk-own5", "Pat Owner");
    const top = await createFolder(db, owner.id, null, "Top");
    const shared = await createFolder(db, owner.id, top.id, "Album");
    const sub = await createFolder(db, owner.id, shared.id, "Day 1");
    const photo = await putFile(owner.id, sub.id, "photo.txt", "photo");
    await putFile(owner.id, shared.id, "notes.txt", "notes");
    const beside = await putFile(owner.id, top.id, "beside.txt", "beside");
    const { token, link } = await linkTo(owner, shared.id);

    const root = await sharedPage(env, db, visitor(), token, null);
    expect(root).toMatchObject({
      state: "open",
      sharedBy: "Pat Owner",
      crumbs: [],
    });

    if (root?.state !== "open") {
      throw new Error("not open");
    }

    expect({
      name: root.node.name,
      rowsMap: root.rows.map((r) => r.name),
    }).toStrictEqual({ name: "Album", rowsMap: ["Day 1", "notes.txt"] });
    // Breadcrumbs start at the shared folder, never at Top above it.
    const deep = await sharedPage(env, db, visitor(), token, photo.id);
    expect({
      value: deep?.state === "open" && deep.crumbs.map((c) => c.name),
      sharedPage: await sharedPage(env, db, visitor(), token, beside.id),
      sharedPage2: await sharedPage(env, db, visitor(), token, top.id),
    }).toStrictEqual({
      value: ["Album", "Day 1"],
      sharedPage: null,
      sharedPage2: null,
    });

    // Each page opened counts.
    const counted = await db.query.driveLinks.findFirst({
      where: eq(driveLinks.id, link.id),
    });

    expect(defined(counted).views).toBe(2);
    expect(JSON.stringify(root)).not.toContain(owner.email);
  });

  it("serves a file as the session route does: inline, as a download, with Range, and 404 once revoked", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("lk-own6");
    const file = await putFile(owner.id, null, "story.txt", "hello world");
    const archive = await putFile(owner.id, null, "bundle.zip", "zip bytes");
    const { token, link } = await linkTo(owner, file.id);
    const path = `/s/${token}/file/${file.id}`;

    let res = await sharedFileResponse(env, db, visitor(path), token, file.id);
    observed.push(
      { status: res.status, resText: await res.text() },
      res.headers.get("content-security-policy")?.includes("sandbox"),
      res.headers.get("content-disposition")?.startsWith("inline"),
      res.headers.get("referrer-policy"),
      res.headers.get("x-robots-tag")?.includes("noindex")
    );

    res = await sharedFileResponse(
      env,
      db,
      visitor(`${path}?download=1`),
      token,
      file.id
    );
    observed.push(
      res.headers.get("content-disposition")?.startsWith("attachment")
    );
    await res.arrayBuffer();
    res = await sharedFileResponse(
      env,
      db,
      visitor(path, { headers: { range: "bytes=0-4" } }),
      token,
      file.id
    );
    observed.push({
      status: res.status,
      resText: await res.text(),
      contentRange: res.headers.get("content-range"),
    });
    // Another file, through this file's link: nothing.
    res = await sharedFileResponse(env, db, visitor(), token, archive.id);
    observed.push(res.status);

    const record = await db.query.driveLinks.findFirst({
      where: eq(driveLinks.id, link.id),
    });

    observed.push(defined(record).downloads);
    await revokeExternalShare(db, owner.id, link.id);
    res = await sharedFileResponse(env, db, visitor(path), token, file.id);
    observed.push({
      status: res.status,
      sharedPage: await sharedPage(env, db, visitor(), token, null),
    });

    expect(observed).toStrictEqual([
      // { status: res.status, resText: await res.text() }
      {
        status: 200,
        resText: "hello world",
      },
      // res.headers.get("content-security-policy").includes("sandbox")
      true,
      // /^inline/u.test(res.headers.get("content-disposition"))
      true,
      // res.headers.get("referrer-policy")
      "no-referrer",
      // res.headers.get("x-robots-tag").includes("noindex")
      true,
      // /^attachment/u.test(res.headers.get("content-disposition"))
      true,
      // { status: res.status, resText: await res.text(), contentRange: res.headers.get("content...
      {
        status: 206,
        resText: "hello",
        contentRange: "bytes 0-4/11",
      },
      // res.status
      404,
      // defined(record).downloads
      1,
      // { status: res.status, sharedPage: await sharedPage(env, db, visitor(), token, null), }
      { status: 404, sharedPage: null },
    ]);
  });

  it("shows but never downloads through a link without downloads", async () => {
    const owner = await mailbox("lk-own7");
    const folder = await createFolder(db, owner.id, null, "Look only");
    const text = await putFile(owner.id, folder.id, "read.txt", "read me");
    const archive = await putFile(owner.id, folder.id, "take.zip", "zip");
    const { token } = await linkTo(owner, folder.id, { allowDownload: false });

    const get = (id: string, download = false) =>
      sharedFileResponse(
        env,
        db,
        visitor(`/s/${token}/file/${id}${download ? "?download=1" : ""}`),
        token,
        id
      );

    const shown = await get(text.id);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-disposition")).toMatch(/^inline/u);
    await shown.arrayBuffer();
    const { status } = await get(text.id, true);
    expect(status).toBe(404);
    // Nothing to preview means nothing to show.
    const { status: getStatus } = await get(archive.id);
    expect(getStatus).toBe(404);
  });

  it("asks a password once, then lets the pass in until it ends, and throttles wrong ones", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("lk-own8");
    const file = await putFile(owner.id, null, "locked.txt", "locked");

    const { token, link } = await linkTo(owner, file.id, {
      password: "letmein1",
    });

    const ip = { "cf-connecting-ip": "198.51.100.7" };

    const post = (password: string) => {
      const form = new FormData();
      form.set("intent", "password");
      form.set("password", password);

      return sharedPagePost(
        env,
        db,
        visitor(`/s/${token}`, { headers: ip }),
        token,
        form
      );
    };

    const openPage = await sharedPage(env, db, visitor(), token, null);

    const { status: openStatus } = await sharedFileResponse(
      env,
      db,
      visitor(),
      token,
      file.id
    );

    observed.push({ sharedPage: openPage, status: openStatus });
    let res = await post("nope");
    observed.push({
      status: res.status,
      location: res.headers.get("location"),
      setCookie: res.headers.get("set-cookie"),
    });

    res = await post("letmein1");
    observed.push(res.headers.get("location"));
    const cookie = defined(res.headers.get("set-cookie"));
    observed.push({
      cookie: /HttpOnly/u.test(cookie),
      cookie2: cookie.includes("Path=/s/"),
    });
    const pass = { cookie: defined(cookie.split(";")[0]) };
    observed.push(await readPasses(visitor("/s/", { headers: pass }), env));

    const page = await sharedPage(
      env,
      db,
      visitor("/s/", { headers: pass }),
      token,
      null
    );

    observed.push(page?.state);

    const bytes = await sharedFileResponse(
      env,
      db,
      visitor("/s/", { headers: pass }),
      token,
      file.id
    );

    observed.push(
      await bytes.text(),
      // A pass that ran out, or one forged for another link, lets nobody in.
      await readPasses(
        visitor("/s/", { headers: pass }),
        env,
        Date.now() + 25 * HOUR
      )
    );

    const forged = await passCookie(visitor(), env, {
      ...link,
      id: "dl_other",
    });

    const renamed = defined(forged.split(";")[0]).replace(
      "drive_pass_dl_other",
      `drive_pass_${link.id}`
    );

    observed.push(
      await readPasses(visitor("/s/", { headers: { cookie: renamed } }), env)
    );

    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the throttle counts attempts as they arrive: the tenth wrong password must land before the next try
      await post("wrong");
    }

    res = await post("letmein1");
    observed.push(res.headers.get("location"));

    expect(observed).toStrictEqual([
      // { sharedPage: await sharedPage(env, db, visitor(), token, null), status: (await sharedF...
      {
        sharedPage: {
          state: "password",
        },
        status: 404,
      },
      // { status: res.status, location: res.headers.get("location"), setCookie: res.headers.get...
      {
        status: 303,
        location: `/s/${token}?error=password`,
        setCookie: null,
      },
      // res.headers.get("location")
      `/s/${token}`,
      // { cookie: /HttpOnly/u.test(cookie), cookie2: cookie.includes("Path=/s/"), }
      { cookie: true, cookie2: true },
      // readPasses(visitor("/s/", { headers: pass }), env)
      new Set([link.id]),
      // page?.state
      "open",
      // bytes.text()
      "locked",
      // readPasses(visitor("/s/", { headers: pass }), env, Date.now() + 25 * HOUR)
      new Set(),
      // readPasses(visitor("/s/", { headers: { cookie: renamed } }), env)
      new Set(),
      // res.headers.get("location")
      `/s/${token}?error=throttled`,
    ]);
  });

  it("refuses every lookup from a client whose tokens kept opening nothing", async () => {
    const owner = await mailbox("lk-own9");
    const file = await putFile(owner.id, null, "guarded.txt", "guarded");
    const { token } = await linkTo(owner, file.id);
    const guesser = { "cf-connecting-ip": "192.0.2.66" };

    for (let i = 0; i < 30; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the lookup throttle counts each client's misses in KV, and parallel requests would race on that count
      const { status } = await sharedFileResponse(
        env,
        db,
        visitor("/s/", { headers: guesser }),
        `guess${i}`,
        file.id
      );

      expect(status).toBe(404);
    }

    const res = await sharedFileResponse(
      env,
      db,
      visitor("/s/", { headers: guesser }),
      token,
      file.id
    );

    expect(res.status).toBe(429);
    await expect(
      sharedPage(env, db, visitor("/s/", { headers: guesser }), token, null)
    ).resolves.toStrictEqual({
      state: "throttled",
    });

    // Anyone else still opens it.
    const { status: fileResponseStatus } = await sharedFileResponse(
      env,
      db,
      visitor(),
      token,
      file.id
    );

    expect(fileResponseStatus).toBe(200);
  });
});

describe("invitations", () => {
  it("mails the invitee, who confirms with a one-time code before anything shows", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("lk-own10", "Ivy Owner");
    const file = await putFile(owner.id, null, "contract.txt", "terms");
    const mail = recordingEmail();

    const { link, url } = await createExternalShare(
      mail.env,
      db,
      owner,
      file.id,
      {
        kind: "invite",
        email: "Guest@Example.org",
        allowDownload: true,
      }
    );

    observed.push({
      email: link.email,
      sent: mail.sent.length,
      String: String(defined(mail.sent[0]).text).includes(url),
      String2: String(defined(mail.sent[0]).subject).includes(
        "Ivy Owner shared"
      ),
    });
    const token = defined(url.split("/s/")[1]);
    const pageBefore = await sharedPage(env, db, visitor(), token, null);

    const { status: statusBefore } = await sharedFileResponse(
      env,
      db,
      visitor(),
      token,
      file.id
    );

    observed.push(
      await rejectionMatches(
        createExternalShare(mail.env, db, owner, file.id, {
          kind: "invite",
          email: "guest@example.org",
          allowDownload: true,
        }),
        /invited already/u
      ),
      await rejectionMatches(
        createExternalShare(mail.env, db, owner, file.id, {
          kind: "invite",
          email: `colleague@${env.MAIL_DOMAIN}`,
          allowDownload: true,
        }),
        /in the workspace/u
      ),
      { sharedPage: pageBefore, status: statusBefore }
    );

    const ip = { "cf-connecting-ip": "198.51.100.20" };

    const post = (fields: Record<string, string>) => {
      const form = new FormData();

      for (const [k, v] of Object.entries(fields)) {
        form.set(k, v);
      }

      return sharedPagePost(
        mail.env,
        db,
        visitor(`/s/${token}`, { headers: ip }),
        token,
        form
      );
    };

    let res = await post({ intent: "send-code" });
    observed.push({
      location: res.headers.get("location"),
      sent: mail.sent.length,
      to: defined(mail.sent[1]).to,
    });

    const code = defined(
      defined(
        String(defined(mail.sent[1]).text).match(/\b(?<code>\d{6})\b/u)
      )[1]
    );

    res = await post({
      intent: "code",
      code: code === "000000" ? "111111" : "000000",
    });
    observed.push(res.headers.get("location"));
    res = await post({ intent: "code", code });
    observed.push(res.headers.get("location"));

    const pass = {
      cookie: defined(defined(res.headers.get("set-cookie")).split(";")[0]),
    };

    const bytes = await sharedFileResponse(
      env,
      db,
      visitor("/s/", { headers: pass }),
      token,
      file.id
    );

    observed.push(await bytes.text());
    // The code is spent; the record says when the invitee first confirmed, and who they are.
    const { headers } = await post({ intent: "code", code });
    observed.push(headers.get("location")?.includes("error=code"));

    const record = await db.query.driveLinks.findFirst({
      where: eq(driveLinks.id, link.id),
    });

    expect(record).toMatchObject({
      email: "guest@example.org",
      codeHash: null,
    });
    observed.push(Boolean(defined(record).confirmedAt));

    // Revoking the invite stops the pass at once.
    await revokeExternalShare(db, owner.id, link.id);

    const { status } = await sharedFileResponse(
      env,
      db,
      visitor("/s/", { headers: pass }),
      token,
      file.id
    );

    observed.push(status);

    expect(observed).toStrictEqual([
      // { email: link.email, sent: mail.sent.length, String: String(defined(mail.sent[0]).text)...
      {
        email: "guest@example.org",
        sent: 1,
        String: true,
        String2: true,
      },
      // /invited already/u.test((await rejection(createExternalShare(mail.env, db, owner, file....
      true,
      // /in the workspace/u.test((await rejection(createExternalShare(mail.env, db, owner, file...
      true,
      // { sharedPage: await sharedPage(env, db, visitor(), token, null), status: (await sharedF...
      {
        sharedPage: {
          state: "invite",
          email: "g•••@example.org",
        },
        status: 404,
      },
      // { location: res.headers.get("location"), sent: mail.sent.length, to: defined(mail.sent[...
      {
        location: `/s/${token}?step=code`,
        sent: 2,
        to: ["guest@example.org"],
      },
      // res.headers.get("location")
      `/s/${token}?step=code&error=code`,
      // res.headers.get("location")
      `/s/${token}`,
      // bytes.text()
      "terms",
      // headers.get("location").includes("error=code")
      true,
      // Boolean(defined(record).confirmedAt)
      true,
      // status
      404,
    ]);
  });

  it("gives a code five tries, and an invite five codes an hour", async () => {
    const owner = await mailbox("lk-own11");
    const file = await putFile(owner.id, null, "tries.txt", "tries");
    const mail = recordingEmail();

    const { url } = await createExternalShare(mail.env, db, owner, file.id, {
      kind: "invite",
      email: "tries@example.org",
      allowDownload: true,
    });

    const token = defined(url.split("/s/")[1]);

    const post = (fields: Record<string, string>) => {
      const form = new FormData();

      for (const [k, v] of Object.entries(fields)) {
        form.set(k, v);
      }

      return sharedPagePost(mail.env, db, visitor(`/s/${token}`), token, form);
    };

    await post({ intent: "send-code" });

    const code = defined(
      defined(
        String(defined(mail.sent.at(-1)).text).match(/\b(?<code>\d{6})\b/u)
      )[1]
    );

    const wrong = code === "123456" ? "654321" : "123456";

    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each wrong code takes one of the five tries on the row, one after another
      await post({ intent: "code", code: wrong });
    }

    const { headers } = await post({ intent: "code", code });
    expect(headers.get("location")).toContain("error=code");

    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each send counts against the code limit before the next one, in order
      await post({ intent: "send-code" });
    }

    const res = await post({ intent: "send-code" });
    expect(res.headers.get("location")).toBe(
      `/s/${token}?step=code&error=codes`
    );
  });

  it("counts a code's tries on the row, not on the copy each guess read", async () => {
    const owner = await mailbox("lk-own12");
    const file = await putFile(owner.id, null, "race.txt", "race");
    const mail = recordingEmail();

    const { link } = await createExternalShare(mail.env, db, owner, file.id, {
      kind: "invite",
      email: "race@example.org",
      allowDownload: true,
    });

    await sendCode(mail.env, db, linkVisits, link, null);

    const code = defined(
      defined(
        String(defined(mail.sent.at(-1)).text).match(/\b(?<code>\d{6})\b/u)
      )[1]
    );

    const wrong = code === "123456" ? "654321" : "123456";

    // Every guess holds the row as it was read before any of them counted, as parallel requests do.
    const stale = defined(
      await db.query.driveLinks.findFirst({
        where: eq(driveLinks.id, link.id),
      })
    );

    await Promise.all(
      Array.from({ length: 8 }, () =>
        confirmCode(db, linkVisits, stale, wrong, null)
      )
    );
    await expect(
      confirmCode(db, linkVisits, stale, code, null)
    ).resolves.toBeFalsy();

    const row = await db.query.driveLinks.findFirst({
      where: eq(driveLinks.id, link.id),
    });

    expect(defined(row).codeAttempts).toBe(5);
  });

  it("takes the page's forms from its own origin or from no browser, never from another site", async () => {
    const owner = await mailbox("lk-own14");
    const file = await putFile(owner.id, null, "origin.txt", "origin");
    const mail = recordingEmail();

    const { url } = await createExternalShare(mail.env, db, owner, file.id, {
      kind: "invite",
      email: "origin@example.org",
      allowDownload: true,
    });

    const invite = defined(url.split("/s/")[1]);

    const { token: locked } = await linkTo(owner, file.id, {
      password: "letmein1",
    });

    const post = (
      token: string,
      fields: Record<string, string>,
      headers: Record<string, string>
    ) => {
      const form = new FormData();

      for (const [k, v] of Object.entries(fields)) {
        form.set(k, v);
      }

      return sharedPagePost(
        mail.env,
        db,
        visitor(`/s/${token}`, { method: "POST", headers }),
        token,
        form
      );
    };

    const answered = (res: Response) => ({
      status: res.status,
      location: res.headers.get("location"),
      pass: res.headers.has("set-cookie"),
      mailed: mail.sent.length,
    });

    const { origin } = new URL(env.APP_URL);
    const sendCodeForm = { intent: "send-code" };
    const password = { intent: "password", password: "letmein1" };

    expect([
      // Another site's page posts with the visitor's browser: nothing is mailed, and no pass is given.
      answered(
        await post(invite, sendCodeForm, { "sec-fetch-site": "cross-site" })
      ),
      answered(await post(locked, password, { "sec-fetch-site": "same-site" })),
      // A browser that sends no `Sec-Fetch-Site` still names the page it posts from.
      answered(
        await post(invite, sendCodeForm, {
          origin: "https://elsewhere.example",
        })
      ),
      // `null` is a sandboxed frame or a page with no referrer; this page sends its referrer to its own origin, so
      // its forms always name it.
      answered(await post(invite, sendCodeForm, { origin: "null" })),
      // The page's own form, a browser before `Sec-Fetch-Site`, and a script that is no browser at all.
      answered(
        await post(invite, sendCodeForm, { "sec-fetch-site": "same-origin" })
      ),
      answered(await post(invite, sendCodeForm, { origin })),
      answered(await post(locked, password, {})),
    ]).toStrictEqual([
      { status: 403, location: null, pass: false, mailed: 1 },
      { status: 403, location: null, pass: false, mailed: 1 },
      { status: 403, location: null, pass: false, mailed: 1 },
      { status: 403, location: null, pass: false, mailed: 1 },
      {
        status: 303,
        location: `/s/${invite}?step=code`,
        pass: false,
        mailed: 2,
      },
      {
        status: 303,
        location: `/s/${invite}?step=code`,
        pass: false,
        mailed: 3,
      },
      { status: 303, location: `/s/${locked}`, pass: true, mailed: 3 },
    ]);
  });

  it("refuses a second live invite to an address, past an expired one", async () => {
    const owner = await mailbox("lk-own13");
    const file = await putFile(owner.id, null, "twice.txt", "twice");
    const mail = recordingEmail();

    const invite = (at = Date.now()) =>
      createExternalShare(
        mail.env,
        db,
        owner,
        file.id,
        {
          kind: "invite",
          email: "twice@example.org",
          allowDownload: true,
          expiresAt: new Date(at + HOUR).toISOString(),
        },
        at
      );

    // Made three hours ago, ended two hours ago, never revoked: it comes first, and must not hide the live one.
    await invite(Date.now() - 3 * HOUR);
    await invite();
    await expect(invite()).rejects.toThrow(/invited already/u);
  });
});
