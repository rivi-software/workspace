import {
  Link,
  createFileRoute,
  notFound,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  FileSignature,
  FolderInput,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Share2,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";

import {
  MoveDialog,
  NameDialog,
  OutsideDetail,
  ShareDialog,
} from "~/components/drive/dialogs";
import { KIND_LABEL, KindIcon } from "~/components/drive/icons";
import { FilePreview } from "~/components/drive/preview";
import { useDriveAction } from "~/components/drive/use-drive-action";
import { useShortcuts } from "~/components/keyboard";
import {
  Avatar,
  IconButton,
  Menu,
  MenuAnchor,
  MenuItem,
  MenuSeparator,
  Notice,
  Pill,
  Timestamp,
  ViewHeader,
  cx,
} from "~/components/ui";
import {
  DRIVE_ROLE_LABEL,
  canEdit,
  fileKind,
  formatSize,
  servesInline,
} from "~/lib/drive/drive";
import type { DriveCrumb, DriveRole } from "~/lib/drive/drive";
import { listShares, nodeDetails } from "~/lib/drive/drive.server";
import type { ShareView } from "~/lib/drive/drive.server";
import { listExternalShares } from "~/lib/drive/links.server";
import type { ExternalSharing } from "~/lib/drive/links.server";
import {
  SIGNING_STATE_LABEL,
  SIGNING_STATE_TONE,
  isPdf,
} from "~/lib/drive/signing";
import { listSigningRequests } from "~/lib/drive/signing.server";
import type { SigningRow } from "~/lib/drive/signing.server";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { DriveError, driveTitle } from "./drive";

export interface FileData {
  node: {
    id: string;
    name: string;
    contentType: string;
    size: number;
    createdAt: string;
    updatedAt: string;
    trashedAt: string | null;
    parentId: string | null;
  };
  role: DriveRole;
  starred: boolean;
  shared: boolean;
  linked: boolean;
  owner: { id: string; name: string };
  crumbs: DriveCrumb[];
  shares: ShareView[];
  /** Its links and invites outside the workspace. */
  external: ExternalSharing;
  /** The requests for signatures on it that the person sent or signs (#2974). */
  signing: SigningRow[];
}

const getFile = createServerFn()
  .validator((d: { nodeId: string }) => d)
  .handler(async ({ data }): Promise<FileData> => {
    const { db, env, user } = await appContext();
    const details = await nodeDetails(db, user.id, data.nodeId);

    if (!details) {
      throw notFound();
    }

    if (details.node.kind === "folder") {
      throw redirect({
        to: "/drive/f/$folderId",
        params: { folderId: details.node.id },
        search: {},
      });
    }

    const n = details.node;

    return {
      node: {
        id: n.id,
        name: n.name,
        contentType: n.contentType,
        size: n.size,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        trashedAt: n.trashedAt,
        parentId: n.parentId,
      },
      role: details.role,
      starred: details.starred,
      shared: details.shared,
      linked: details.linked,
      owner: details.owner,
      crumbs: details.crumbs,
      shares:
        details.role === "owner" ? await listShares(db, user.id, n.id) : [],
      external: await listExternalShares(env, db, user.id, n.id),
      signing: await listSigningRequests(db, user.id, { nodeId: n.id }),
    };
  });

const Detail = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div>
    <dt className="text-subtle text-xs">{label}</dt>
    <dd className="text-fg min-w-0 break-words">{children}</dd>
  </div>
);

type FileDialog = "rename" | "move" | "share";

/** The Drive list a file with no folder goes back to: My Drive for its owner, what is shared otherwise. */
const homeSearch = (role: DriveRole) =>
  role === "owner" ? ({} as const) : ({ view: "shared" } as const);

/** What the Sharing detail says of the people the file is shared with. */
const sharingLabel = (shares: ShareView[], shared: boolean) => {
  if (shares.length) {
    return shares
      .map(
        (s) =>
          `${s.person ? s.person.name : "Everyone"} (${DRIVE_ROLE_LABEL[s.role].toLowerCase()})`
      )
      .join(", ");
  }

  return shared ? "Shared" : "Not shared";
};

const FileTitle = ({
  node,
  linked,
  starred,
}: {
  node: FileData["node"];
  linked: boolean;
  starred: boolean;
}) => (
  <span className="flex min-w-0 items-center gap-2">
    <KindIcon
      kind="file"
      name={node.name}
      contentType={node.contentType}
      className="h-4 w-4"
    />
    <span className="truncate">{node.name}</span>
    {linked && (
      <Link2
        className="text-subtle h-3.5 w-3.5 shrink-0"
        aria-label="Shared outside the workspace"
      />
    )}
    {starred && (
      <Star
        className="fill-star text-star h-3 w-3 shrink-0"
        aria-label="Starred"
      />
    )}
  </span>
);

interface FileActionsProps {
  inTrash: boolean;
  starred: boolean;
  signable: boolean;
  inline: boolean;
  editable: boolean;
  fileUrl: string;
  restore: () => void;
  deleteForever: () => void;
  star: () => void;
  trash: () => void;
  requestSignatures: () => void;
  openDialog: (dialog: FileDialog) => void;
}

const FileMenu = ({
  inline,
  editable,
  signable,
  fileUrl,
  trash,
  requestSignatures,
  openDialog,
}: Pick<
  FileActionsProps,
  | "inline"
  | "editable"
  | "signable"
  | "fileUrl"
  | "trash"
  | "requestSignatures"
  | "openDialog"
>) => (
  <Menu
    label="More"
    renderTrigger={({ toggle, open }) => (
      <IconButton
        label="More"
        onClick={toggle}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
    )}
  >
    {inline && (
      <MenuAnchor
        href={fileUrl}
        target="_blank"
        rel="noopener"
        icon={<ExternalLink className="h-3.5 w-3.5" />}
      >
        Open in a new tab
      </MenuAnchor>
    )}
    <MenuAnchor
      href={`${fileUrl}?download=1`}
      icon={<Download className="h-3.5 w-3.5" />}
    >
      Download
    </MenuAnchor>
    {signable && (
      <MenuItem
        icon={<FileSignature className="h-3.5 w-3.5" />}
        onClick={requestSignatures}
      >
        Request signatures
      </MenuItem>
    )}
    {editable && (
      <>
        <MenuSeparator />
        <MenuItem
          icon={<Pencil className="h-3.5 w-3.5" />}
          onClick={() => openDialog("rename")}
        >
          Rename
        </MenuItem>
        <MenuItem
          icon={<FolderInput className="h-3.5 w-3.5" />}
          onClick={() => openDialog("move")}
        >
          Move
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={trash}
        >
          Move to trash
        </MenuItem>
      </>
    )}
  </Menu>
);

const FileActions = ({
  inTrash,
  starred,
  signable,
  inline,
  editable,
  fileUrl,
  restore,
  deleteForever,
  star,
  trash,
  requestSignatures,
  openDialog,
}: FileActionsProps) => {
  if (inTrash) {
    return (
      <>
        <IconButton label="Restore" onClick={restore}>
          <RotateCcw className="h-4 w-4" />
        </IconButton>
        <IconButton label="Delete forever (#)" onClick={deleteForever}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </>
    );
  }

  return (
    <>
      <a
        href={`${fileUrl}?download=1`}
        className="text-muted hover:bg-hover hover:text-fg inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
        aria-label="Download"
        title="Download"
      >
        <Download className="h-4 w-4" />
      </a>
      <IconButton label={starred ? "Unstar (s)" : "Star (s)"} onClick={star}>
        <Star className={cx("h-4 w-4", starred && "fill-star text-star")} />
      </IconButton>
      <IconButton label="Share" onClick={() => openDialog("share")}>
        <Share2 className="h-4 w-4" />
      </IconButton>
      {signable && (
        <IconButton label="Request signatures" onClick={requestSignatures}>
          <FileSignature className="h-4 w-4" />
        </IconButton>
      )}
      <FileMenu
        inline={inline}
        editable={editable}
        signable={signable}
        fileUrl={fileUrl}
        trash={trash}
        requestSignatures={requestSignatures}
        openDialog={openDialog}
      />
    </>
  );
};

const FileDetails = ({
  data,
  signable,
  openDialog,
}: {
  data: FileData;
  signable: boolean;
  openDialog: (dialog: FileDialog) => void;
}) => {
  const { node, role, shared, owner, crumbs, shares, external, signing } = data;
  const parent = crumbs.at(-1) ?? null;
  const kind = fileKind(node.contentType, node.name, "file");

  return (
    <aside
      aria-label="Details"
      className="border-line bg-sidebar shrink-0 border-t px-4 py-4 text-base xl:w-72 xl:overflow-y-auto xl:border-t-0 xl:border-l"
    >
      <h2 className="text-subtle mb-3 text-sm font-medium">Details</h2>
      <dl className="space-y-2.5">
        <Detail label="Type">{KIND_LABEL[kind]}</Detail>
        <Detail label="Size">
          <span className="tnum">{formatSize(node.size)}</span>
        </Detail>
        <Detail label="Owner">
          <span className="flex items-center gap-1.5">
            <Avatar name={owner.name} size={16} />
            {role === "owner" ? "me" : owner.name}
          </span>
        </Detail>
        <Detail label="Location">
          {parent ? (
            <Link
              to="/drive/f/$folderId"
              params={{ folderId: parent.id }}
              search={{}}
              className="text-accent hover:underline"
            >
              {parent.name}
            </Link>
          ) : (
            <Link
              to="/drive"
              search={homeSearch(role)}
              className="text-accent hover:underline"
            >
              {role === "owner" ? "My Drive" : "Shared with me"}
            </Link>
          )}
        </Detail>
        <Detail label="Modified">
          <Timestamp iso={node.updatedAt} relative={false} />
        </Detail>
        <Detail label="Added">
          <Timestamp iso={node.createdAt} relative={false} />
        </Detail>
        {node.trashedAt && (
          <Detail label="Trashed">
            <Timestamp iso={node.trashedAt} relative={false} />
          </Detail>
        )}
        <Detail label="Sharing">
          {role === "owner" ? (
            <button
              type="button"
              onClick={() => openDialog("share")}
              className="text-accent text-left hover:underline"
            >
              {sharingLabel(shares, shared)}
            </button>
          ) : (
            <span className="flex items-center gap-1.5">
              <Users className="text-subtle h-3.5 w-3.5" />
              {role === "editor" ? "You can edit" : "You can view"}
            </span>
          )}
        </Detail>
        <Detail label="Outside the workspace">
          <OutsideDetail
            nodeId={node.id}
            external={external}
            onManage={node.trashedAt ? undefined : () => openDialog("share")}
          />
        </Detail>
        {(signable || signing.length > 0) && (
          <Detail label="Signatures">
            <ul className="space-y-1">
              {signing.map((r) => (
                <li key={r.id}>
                  <Link
                    to="/drive/sign/r/$requestId"
                    params={{ requestId: r.id }}
                    className="flex items-center gap-1.5 hover:underline"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {r.customer.name}
                    </span>
                    <Pill tone={SIGNING_STATE_TONE[r.state]}>
                      {SIGNING_STATE_LABEL[r.state]}
                    </Pill>
                  </Link>
                </li>
              ))}
              {signable && (
                <li>
                  <Link
                    to="/drive/sign/new/$nodeId"
                    params={{ nodeId: node.id }}
                    className="text-accent hover:underline"
                  >
                    Request signatures
                  </Link>
                </li>
              )}
            </ul>
          </Detail>
        )}
      </dl>
    </aside>
  );
};

const FileView = ({ data }: { data: FileData }) => {
  const { node, role, starred, linked, crumbs } = data;
  const signable = isPdf(node.contentType, node.name) && !node.trashedAt;
  const navigate = useNavigate();
  const run = useDriveAction();
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const editable = canEdit(role);
  const inTrash = !!node.trashedAt;
  const fileUrl = `/api/drive/files/${node.id}`;
  const parent = crumbs.at(-1) ?? null;

  const requestSignatures = () => {
    navigate({
      to: "/drive/sign/new/$nodeId",
      params: { nodeId: node.id },
    });
  };

  const back = () => {
    if (parent) {
      navigate({
        to: "/drive/f/$folderId",
        params: { folderId: parent.id },
        search: {},
      });
    } else {
      navigate({
        to: "/drive",
        search: inTrash ? { view: "trash" } : homeSearch(role),
      });
    }
  };

  const star = () => {
    run({ intent: starred ? "unstar" : "star", id: node.id }, { quiet: true });
  };

  const trash = () => {
    run({ intent: "trash", id: node.id }, { after: back });
  };

  const restore = () => {
    run({ intent: "restore", id: node.id });
  };

  const deleteForever = () => {
    // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
    if (!confirm("Delete this file forever? This cannot be undone.")) {
      return;
    }

    run({ intent: "delete", id: node.id }, { after: back });
  };

  useShortcuts([
    { keys: "u", run: back },
    { keys: "Backspace", run: back },
    { keys: "s", run: () => !inTrash && star() },
    { keys: "r", run: () => !inTrash && editable && setDialog("rename") },
    { keys: "m", run: () => !inTrash && editable && setDialog("move") },
    { keys: "#", run: () => (inTrash ? deleteForever() : editable && trash()) },
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title={<FileTitle node={node} linked={linked} starred={starred} />}
        left={
          <IconButton label="Back (u)" onClick={back}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        }
      >
        <FileActions
          inTrash={inTrash}
          starred={starred}
          signable={signable}
          inline={servesInline(node.contentType)}
          editable={editable}
          fileUrl={fileUrl}
          restore={restore}
          deleteForever={deleteForever}
          star={star}
          trash={trash}
          requestSignatures={requestSignatures}
          openDialog={setDialog}
        />
      </ViewHeader>

      {inTrash && (
        <div className="px-4 pt-3">
          <Notice>
            This file is in the trash. Restore it to work with it again.
          </Notice>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
        <section
          aria-label="Preview"
          className="min-w-0 flex-1 xl:overflow-y-auto"
        >
          <FilePreview
            src={fileUrl}
            download={`${fileUrl}?download=1`}
            name={node.name}
            contentType={node.contentType}
            size={node.size}
          />
        </section>
        <FileDetails data={data} signable={signable} openDialog={setDialog} />
      </div>

      <NameDialog
        open={dialog === "rename"}
        title="Rename"
        initial={node.name}
        submitLabel="Rename"
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const r = await run(
            { intent: "rename", id: node.id, name },
            { quiet: true }
          );

          return !!r?.ok;
        }}
      />
      <MoveDialog
        open={dialog === "move"}
        ids={[node.id]}
        currentId={node.parentId}
        onClose={() => setDialog(null)}
      />
      <ShareDialog
        open={dialog === "share"}
        node={{ id: node.id, name: node.name, kind: "file" }}
        onClose={() => setDialog(null)}
      />
    </div>
  );
};

const FilePage = () => {
  const data = Route.useLoaderData();

  return <FileView key={data.node.id} data={data} />;
};

/** A file: its preview, its details, and the actions on it. */
export const Route = createFileRoute("/_app/drive/d/$nodeId")({
  // The file stays when the minute's refresh cannot load it again (#3548).
  loader: (run) =>
    keepShown(run, () =>
      getFile({ data: { nodeId: run.params.nodeId }, fetch: serverFnFetch })
    ),
  head: ({ loaderData }) => ({
    meta: [{ title: driveTitle(loaderData?.node.name ?? "File") }],
  }),
  component: FilePage,
  errorComponent: DriveError,
});
