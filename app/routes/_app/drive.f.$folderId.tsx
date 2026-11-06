import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { DriveBrowser } from "~/components/drive/browser";
import type { DriveListData } from "~/components/drive/browser";
import { MailSelectionProvider } from "~/components/mail-selection";
import { canEdit, isDriveSort } from "~/lib/drive/drive";
import type { DriveDir, DriveSort } from "~/lib/drive/drive";
import { listFolder } from "~/lib/drive/drive.server";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { DriveError, driveTitle } from "./drive";

const getFolder = createServerFn()
  .validator((d: { folderId: string; sort?: string; dir?: string }) => d)
  .handler(async ({ data }): Promise<DriveListData> => {
    const { db, user } = await appContext();
    const sort: DriveSort = isDriveSort(data.sort) ? data.sort : "name";
    const dir: DriveDir = data.dir === "desc" ? "desc" : "asc";
    const listing = await listFolder(db, user.id, data.folderId, { sort, dir });

    if (!listing?.folder) {
      throw notFound();
    }

    return {
      view: listing.folder.role === "owner" ? "mine" : "shared",
      q: "",
      sort,
      dir,
      folder: listing.folder,
      crumbs: listing.crumbs,
      rows: listing.rows,
      canWrite: canEdit(listing.folder.role),
    };
  });

const FolderPage = () => {
  const data = Route.useLoaderData();

  return (
    <MailSelectionProvider>
      <DriveBrowser key={data.folder?.id} data={data} />
    </MailSelectionProvider>
  );
};

/** A folder: its contents, with the breadcrumbs above it as far as the person may see. */
export const Route = createFileRoute("/_app/drive/f/$folderId")({
  loaderDeps: ({ search }) => ({ sort: search.sort, dir: search.dir }),
  // The folder stays when the minute's refresh cannot load it again (#3548).
  loader: (run) =>
    keepShown(run, () =>
      getFolder({
        data: { folderId: run.params.folderId, ...run.deps },
        fetch: serverFnFetch,
      })
    ),
  head: ({ loaderData }) => ({
    meta: [{ title: driveTitle(loaderData?.folder?.name ?? "Folder") }],
  }),
  component: FolderPage,
  errorComponent: DriveError,
});
