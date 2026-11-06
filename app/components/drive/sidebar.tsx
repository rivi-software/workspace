import { Link, useLocation } from "@tanstack/react-router";
import {
  Clock,
  FileSignature,
  FolderInput,
  FolderPlus,
  HardDrive,
  Plus,
  Star,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useRef, useState } from "react";

import { DRIVE_VIEW_LABEL, formatSize, isDriveView } from "~/lib/drive/drive";
import type { DriveView } from "~/lib/drive/drive";
import { SIGNING_LIST_HREF } from "~/lib/drive/signing";
import { isJsonObject, stringOrNull } from "~/lib/guards";

import { Menu, MenuItem, MenuSeparator, cx } from "../ui";
import { NameDialog } from "./dialogs";
import { useUploads } from "./uploads";
import { useDriveAction } from "./use-drive-action";

const VIEWS: {
  view: DriveView;
  icon: React.ComponentType<{ className?: string }>;
  key?: string;
}[] = [
  { view: "mine", icon: HardDrive, key: "g f" },
  { view: "shared", icon: Users },
  { view: "recent", icon: Clock },
  { view: "starred", icon: Star },
  { view: "trash", icon: Trash2 },
];

/** The folder a Drive page is on, from its path, for New and the uploads from the sidebar. */
export const currentFolderId = (pathname: string): string | null =>
  pathname.match(/^\/drive\/f\/(?<id>[^/]+)/u)?.[1] ?? null;

/** The view the sidebar marks: the listing's own (My Drive when the address names none, none for one it does not know), My Drive inside a folder, none elsewhere. */
const activeViewOf = (
  onIndex: boolean,
  folderId: string | null,
  view: string | undefined
): DriveView | null => {
  if (!onIndex) {
    return folderId ? "mine" : null;
  }

  if (view === undefined) {
    return "mine";
  }

  return isDriveView(view) ? view : null;
};

/** Drive's part of the sidebar: New, the views, and how much the person's files take. */
export const DriveSidebar = ({ used }: { used: number }) => {
  const location = useLocation();
  const uploads = useUploads();
  const run = useDriveAction();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const folderId = currentFolderId(location.pathname);
  const { search } = location;
  const onIndex = /^\/drive\/?$/u.test(location.pathname);
  const onSigning = location.pathname.startsWith(SIGNING_LIST_HREF);

  const activeView = activeViewOf(
    onIndex,
    folderId,
    (isJsonObject(search) ? stringOrNull(search.view) : null) ?? undefined
  );

  const onFiles = (files: FileList | null) => {
    const list = [...(files ?? [])];

    if (list.length) {
      uploads.add(list, folderId);
    }
  };

  return (
    <>
      <div className="px-3 pb-3">
        <Menu
          label="New"
          align="start"
          className="w-full"
          menuClassName="w-full"
          renderTrigger={({ toggle, open }) => (
            <button
              type="button"
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              className="bg-accent text-accent-fg hover:bg-accent-hover flex h-7 w-full items-center justify-center gap-1.5 rounded-md px-2.5 text-base font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_1px_rgb(0_0_0/0.08)] transition-colors"
              title="New (n for a folder, u to upload)"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          )}
        >
          <MenuItem
            icon={<FolderPlus className="h-3.5 w-3.5" />}
            onClick={() => setNewFolder(true)}
          >
            New folder
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Upload className="h-3.5 w-3.5" />}
            onClick={() => fileInput.current?.click()}
          >
            Upload files
          </MenuItem>
          <MenuItem
            icon={<FolderInput className="h-3.5 w-3.5" />}
            onClick={() => folderInput.current?.click()}
          >
            Upload folder
          </MenuItem>
        </Menu>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Drive">
        <div className="text-subtle mb-1 px-2 text-xs font-medium">Drive</div>
        <ul className="space-y-px">
          {VIEWS.map(({ view, icon: Icon }) => {
            const active = activeView === view;

            return (
              <li key={view}>
                <Link
                  to="/drive"
                  search={view === "mine" ? {} : { view }}
                  className={cx(
                    "flex h-7 items-center gap-2 rounded-md px-2 text-base transition-colors duration-100",
                    active
                      ? "bg-active text-fg"
                      : "text-muted hover:bg-hover hover:text-fg"
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">
                    {DRIVE_VIEW_LABEL[view]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <ul className="mt-3 space-y-px">
          <li>
            <Link
              to="/drive/sign"
              className={cx(
                "flex h-7 items-center gap-2 rounded-md px-2 text-base transition-colors duration-100",
                onSigning
                  ? "bg-active text-fg"
                  : "text-muted hover:bg-hover hover:text-fg"
              )}
              aria-current={onSigning ? "page" : undefined}
            >
              <FileSignature className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">Signatures</span>
            </Link>
          </li>
        </ul>
        <div className="text-subtle mt-4 px-2 text-xs">
          <span className="tnum">{formatSize(used)}</span> used
        </div>
      </nav>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          onFiles(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={(el) => {
          folderInput.current = el;
          el?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          onFiles(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      <NameDialog
        open={newFolder}
        title="New folder"
        submitLabel="Create"
        onClose={() => setNewFolder(false)}
        onSubmit={async (name) => {
          const r = await run(
            { intent: "folder", parent: folderId ?? "", name },
            { quiet: true }
          );

          return !!r?.ok;
        }}
      />
    </>
  );
};
