import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";

import { DriveBrowser } from "~/components/drive/browser";
import type { DriveListData } from "~/components/drive/browser";
import { MailSelectionProvider } from "~/components/mail-selection";
import { DRIVE_VIEW_LABEL, isDriveSort, isDriveView } from "~/lib/drive/drive";
import type { DriveDir, DriveSort, DriveView } from "~/lib/drive/drive";
import { listView, pruneDrive } from "~/lib/drive/drive.server";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { DriveError, driveTitle } from "./drive";

interface Deps {
  view?: string;
  q?: string;
  sort?: string;
  dir?: string;
}

/** Recent reads newest first unless asked otherwise. */
const defaultSort = (view: DriveView): DriveSort =>
  view === "recent" ? "updated" : "name";

const defaultDir = (sort: DriveSort): DriveDir =>
  sort === "name" ? "asc" : "desc";

/** The page's title: what is searched for, else the view. */
const pageTitle = (data: DriveListData | undefined) => {
  if (!data) {
    return "Drive";
  }

  return data.q ? "Search" : DRIVE_VIEW_LABEL[data.view];
};

const getDrive = createServerFn()
  .validator((d: Deps) => d)
  .handler(async ({ data }): Promise<DriveListData> => {
    const { db, env, user } = await appContext();
    const q = (data.q ?? "").trim();
    const view = isDriveView(data.view) ? data.view : "mine";

    const sort: DriveSort = isDriveSort(data.sort)
      ? data.sort
      : defaultSort(view);

    const dir: DriveDir =
      data.dir === "desc" || data.dir === "asc" ? data.dir : defaultDir(sort);

    const order = { sort, dir };
    // Housekeeping a few times a day, after the response: the old trash and abandoned uploads go.
    const pruneKey = `drive-prune:${user.id}`;

    if (!(await env.KV.get(pruneKey))) {
      await env.KV.put(pruneKey, "1", { expirationTtl: 6 * 3600 });
      waitUntil(pruneDrive(env, db, user.id));
    }

    const rows = await listView(db, user.id, q ? { search: q } : view, order);

    return {
      view,
      q,
      sort,
      dir,
      folder: null,
      crumbs: [],
      rows,
      canWrite: !q && view === "mine",
    };
  });

const DrivePage = () => {
  const data = Route.useLoaderData();

  return (
    <MailSelectionProvider>
      <DriveBrowser data={data} />
    </MailSelectionProvider>
  );
};

export const Route = createFileRoute("/_app/drive/")({
  loaderDeps: ({ search }) => ({
    view: search.view,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
  }),
  // The listing stays when the minute's refresh cannot load it again (#3548).
  loader: (run) =>
    keepShown(run, () => getDrive({ data: run.deps, fetch: serverFnFetch })),
  head: ({ loaderData }) => ({
    meta: [{ title: driveTitle(pageTitle(loaderData)) }],
  }),
  component: DrivePage,
  errorComponent: DriveError,
});
