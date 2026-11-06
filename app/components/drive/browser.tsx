import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckSquare,
  ChevronRight,
  Download,
  FolderInput,
  FolderPlus,
  HardDrive,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  Share2,
  Star,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import {
  DRIVE_EXPIRY_DAYS,
  DRIVE_SORTS,
  DRIVE_SORT_LABEL,
  DRIVE_VIEW_LABEL,
  canEdit,
  formatSize,
  servesInline,
} from "~/lib/drive/drive";
import type {
  DriveCrumb,
  DriveDir,
  DriveRole,
  DriveRow,
  DriveSort,
  DriveView,
} from "~/lib/drive/drive";

import { useListNavigation, useShortcuts } from "../keyboard";
import { useSelection } from "../mail-selection";
import {
  Button,
  Checkbox,
  Empty,
  IconButton,
  Menu,
  MenuAnchor,
  MenuItem,
  MenuSeparator,
  SearchField,
  Timestamp,
  ViewHeader,
  cx,
  searchClearClass,
} from "../ui";
import { MoveDialog, NameDialog, ShareDialog } from "./dialogs";
import { KindIcon } from "./icons";
import { useUploads } from "./uploads";
import { useDriveAction } from "./use-drive-action";

export interface DriveFolderHead {
  id: string;
  name: string;
  role: DriveRole;
  owner: { id: string; name: string };
  starred: boolean;
  shared: boolean;
  linked: boolean;
}

export interface DriveListData {
  view: DriveView;
  q: string;
  sort: DriveSort;
  dir: DriveDir;
  /** The open folder; null at the root of a view. */
  folder: DriveFolderHead | null;
  crumbs: DriveCrumb[];
  rows: DriveRow[];
  /** Whether things can be made and uploaded here. */
  canWrite: boolean;
}

interface OrderSearch {
  sort?: string;
  dir?: string;
}

/** The sort order as links keep it: only when it is not the default. */
const orderSearch = (
  data: Pick<DriveListData, "sort" | "dir">,
  over: Partial<OrderSearch> = {}
): OrderSearch => {
  const out: OrderSearch = {};
  const sort = over.sort ?? data.sort;
  const dir = over.dir ?? data.dir;

  if (sort !== "name") {
    out.sort = sort;
  }

  if (dir !== "asc") {
    out.dir = dir;
  }

  return out;
};

/** A link to the listing of a view, or of a search, in an order. */
const viewSearchOf = (data: DriveListData, order: OrderSearch) => {
  if (data.q) {
    return { q: data.q, ...order };
  }

  if (data.view === "mine") {
    return order;
  }

  return { view: data.view, ...order };
};

/** The direction a click on a column asks for: the other way on the sorted column, else its natural one. */
const nextDirOf = (data: DriveListData, column: DriveSort): DriveDir => {
  if (data.sort === column) {
    return data.dir === "asc" ? "desc" : "asc";
  }

  return column === "name" ? "asc" : "desc";
};

/** The id of the row that has the focus, if one does. */
const focusedNodeId = (): string | null =>
  document.activeElement?.closest<HTMLElement>("[data-node]")?.dataset.node ??
  null;

type DialogState =
  | { kind: "folder" }
  | { kind: "rename"; row: DriveRow }
  | { kind: "move"; ids: string[] }
  | { kind: "share"; row: DriveRow }
  | null;

const Crumbs = ({
  rootView,
  rootSearch,
  crumbs,
  title,
  order,
  linked,
}: {
  rootView: DriveView;
  rootSearch: Record<string, string>;
  crumbs: DriveCrumb[];
  title: string;
  order: OrderSearch;
  /** The open folder has a live link outside the workspace. */
  linked: boolean;
}) => {
  const atRoot = title === DRIVE_VIEW_LABEL[rootView] && !crumbs.length;

  if (atRoot || title === "Search") {
    return <span>{title}</span>;
  }

  const RootIcon = rootView === "shared" ? Users : HardDrive;

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1 text-base"
    >
      <Link
        to="/drive"
        search={rootSearch}
        className="text-muted hover:text-fg flex items-center gap-1"
      >
        <RootIcon className="h-3.5 w-3.5" />
        <span className="hidden @xl:inline">{DRIVE_VIEW_LABEL[rootView]}</span>
      </Link>
      {crumbs.map((c) => (
        <span key={c.id} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="text-faint h-3 w-3 shrink-0" />
          <Link
            to="/drive/f/$folderId"
            params={{ folderId: c.id }}
            search={order}
            className="text-muted hover:text-fg max-w-40 truncate"
          >
            {c.name}
          </Link>
        </span>
      ))}
      <ChevronRight className="text-faint h-3 w-3 shrink-0" />
      <span className="text-fg truncate font-medium" aria-current="page">
        {title}
      </span>
      {linked && (
        <Link2
          className="text-subtle h-3.5 w-3.5 shrink-0"
          aria-label="Shared outside the workspace"
        />
      )}
    </nav>
  );
};

/** A link to this listing with another order. */
const OrderLink = ({
  data,
  folderId,
  sort,
  dir,
  className,
  children,
  label,
}: {
  data: DriveListData;
  folderId: string | null;
  sort: DriveSort;
  dir: DriveDir;
  className?: string;
  children: ReactNode;
  label?: string;
}) => {
  const search = orderSearch(data, { sort, dir });

  if (folderId) {
    return (
      <Link
        to="/drive/f/$folderId"
        params={{ folderId }}
        search={search}
        className={className}
        aria-label={label}
      >
        {children}
      </Link>
    );
  }

  return (
    <Link
      to="/drive"
      search={viewSearchOf(data, search)}
      className={className}
      aria-label={label}
    >
      {children}
    </Link>
  );
};

const SortHeader = ({
  data,
  folderId,
  column,
  className,
  children,
}: {
  data: DriveListData;
  folderId: string | null;
  column: DriveSort;
  className?: string;
  children: ReactNode;
}) => {
  const active = data.sort === column;

  return (
    <OrderLink
      data={data}
      folderId={folderId}
      sort={column}
      dir={nextDirOf(data, column)}
      className={cx(
        "flex items-center gap-1 hover:text-fg",
        active && "text-fg",
        className
      )}
      label={`Sort by ${DRIVE_SORT_LABEL[column].toLowerCase()}`}
    >
      {children}
      {active &&
        (data.dir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        ))}
    </OrderLink>
  );
};

const SortMenu = ({
  data,
  folderId,
}: {
  data: DriveListData;
  folderId: string | null;
}) => {
  const navigate = useNavigate();

  const go = (sort: DriveSort, dir: DriveDir) => {
    const search = orderSearch(data, { sort, dir });

    if (folderId) {
      void navigate({ to: "/drive/f/$folderId", params: { folderId }, search });
    } else {
      void navigate({ to: "/drive", search: viewSearchOf(data, search) });
    }
  };

  return (
    <Menu
      label="Sort"
      renderTrigger={({ toggle, open }) => (
        <IconButton
          label="Sort"
          onClick={toggle}
          active={open}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          {data.dir === "asc" ? (
            <ArrowUp className="h-4 w-4" />
          ) : (
            <ArrowDown className="h-4 w-4" />
          )}
        </IconButton>
      )}
    >
      {DRIVE_SORTS.map((s) => (
        <MenuItem key={s} onClick={() => go(s, nextDirOf(data, s))}>
          <span className="flex items-center justify-between">
            {DRIVE_SORT_LABEL[s]}
            {s === data.sort && <Check className="text-accent h-3.5 w-3.5" />}
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onClick={() => go(data.sort, "asc")}>
        <span className="flex items-center justify-between">
          Ascending
          {data.dir === "asc" && <Check className="text-accent h-3.5 w-3.5" />}
        </span>
      </MenuItem>
      <MenuItem onClick={() => go(data.sort, "desc")}>
        <span className="flex items-center justify-between">
          Descending
          {data.dir === "desc" && <Check className="text-accent h-3.5 w-3.5" />}
        </span>
      </MenuItem>
    </Menu>
  );
};

const BulkToolbar = ({
  rows,
  inTrash,
  onStar,
  onRename,
  onMove,
  onShare,
  onTrash,
  onRestore,
  onDelete,
}: {
  rows: DriveRow[];
  inTrash: boolean;
  onStar: () => void;
  onRename: () => void;
  onMove: () => void;
  onShare: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) => {
  const one = rows.length === 1 ? rows[0] : null;
  const editable = rows.every((r) => canEdit(r.role));
  const allStarred = rows.every((r) => r.starred);

  if (inTrash) {
    return (
      <>
        <IconButton label="Restore" onClick={onRestore}>
          <RotateCcw className="h-4 w-4" />
        </IconButton>
        <IconButton label="Delete forever (#)" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </>
    );
  }

  return (
    <>
      {one?.kind === "file" && (
        <a
          href={`/api/drive/files/${one.id}?download=1`}
          className="text-muted hover:bg-hover hover:text-fg inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
          aria-label="Download"
          title="Download"
        >
          <Download className="h-4 w-4" />
        </a>
      )}
      <IconButton
        label={allStarred ? "Unstar (s)" : "Star (s)"}
        onClick={onStar}
      >
        <Star className={cx("h-4 w-4", allStarred && "fill-star text-star")} />
      </IconButton>
      {one && canEdit(one.role) && (
        <IconButton label="Rename (r)" onClick={onRename}>
          <Pencil className="h-4 w-4" />
        </IconButton>
      )}
      {editable && (
        <IconButton label="Move (m)" onClick={onMove}>
          <FolderInput className="h-4 w-4" />
        </IconButton>
      )}
      {one && (
        <IconButton label="Share" onClick={onShare}>
          <Share2 className="h-4 w-4" />
        </IconButton>
      )}
      {editable && (
        <IconButton label="Move to trash (#)" onClick={onTrash}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      )}
    </>
  );
};

/** A row's name: a link into the folder or the file, or plain text in the trash. */
const NodeName = ({
  row,
  order,
  inTrash,
}: {
  row: DriveRow;
  order: OrderSearch;
  inTrash: boolean;
}) => {
  if (inTrash) {
    return (
      <span
        data-row
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a trashed row has no link, so its name is what takes the focus that j and k move along
        tabIndex={0}
        className="text-fg truncate focus:outline-none"
      >
        {row.name}
      </span>
    );
  }

  if (row.kind === "folder") {
    return (
      <Link
        to="/drive/f/$folderId"
        params={{ folderId: row.id }}
        search={order}
        data-row
        className="text-fg truncate focus:outline-none focus-visible:underline"
      >
        {row.name}
      </Link>
    );
  }

  return (
    <Link
      to="/drive/d/$nodeId"
      params={{ nodeId: row.id }}
      search={{}}
      data-row
      className="text-fg truncate focus:outline-none focus-visible:underline"
    >
      {row.name}
    </Link>
  );
};

interface RowActions {
  onStar: () => void;
  onRename: () => void;
  onMove: () => void;
  onShare: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

/** What a row's "More" menu offers: restore or delete in the trash, else everything its role allows. */
const RowMenuItems = ({
  row,
  inTrash,
  onOpen,
  onStar,
  onRename,
  onMove,
  onShare,
  onTrash,
  onRestore,
  onDelete,
}: RowActions & {
  row: DriveRow;
  inTrash: boolean;
  onOpen: () => void;
}) => {
  const fileUrl = `/api/drive/files/${row.id}`;
  const editable = canEdit(row.role);

  if (inTrash) {
    return (
      <>
        <MenuItem
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={onRestore}
        >
          Restore
        </MenuItem>
        <MenuItem
          danger
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={onDelete}
        >
          Delete forever
        </MenuItem>
      </>
    );
  }

  return (
    <>
      <MenuItem
        icon={<ChevronRight className="h-3.5 w-3.5" />}
        onClick={onOpen}
      >
        Open
      </MenuItem>
      {row.kind === "file" && servesInline(row.contentType) && (
        <MenuAnchor
          href={fileUrl}
          target="_blank"
          rel="noopener"
          icon={<Download className="h-3.5 w-3.5 rotate-180" />}
        >
          Open in a new tab
        </MenuAnchor>
      )}
      {row.kind === "file" && (
        <MenuAnchor
          href={`${fileUrl}?download=1`}
          icon={<Download className="h-3.5 w-3.5" />}
        >
          Download
        </MenuAnchor>
      )}
      <MenuItem icon={<Star className="h-3.5 w-3.5" />} onClick={onStar}>
        {row.starred ? "Unstar" : "Star"}
      </MenuItem>
      {editable && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<Pencil className="h-3.5 w-3.5" />}
            onClick={onRename}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon={<FolderInput className="h-3.5 w-3.5" />}
            onClick={onMove}
          >
            Move
          </MenuItem>
        </>
      )}
      <MenuItem icon={<Share2 className="h-3.5 w-3.5" />} onClick={onShare}>
        Share
      </MenuItem>
      {editable && (
        <>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onTrash}
          >
            Move to trash
          </MenuItem>
        </>
      )}
    </>
  );
};

const NodeRow = ({
  row,
  order,
  inTrash,
  showOwner,
  selected,
  onSelect,
  onStar,
  onRename,
  onMove,
  onShare,
  onTrash,
  onRestore,
  onDelete,
}: RowActions & {
  row: DriveRow;
  order: OrderSearch;
  inTrash: boolean;
  showOwner: boolean;
  selected: boolean;
  onSelect: (on: boolean, range: boolean) => void;
}) => {
  const navigate = useNavigate();

  const open = () => {
    if (inTrash) {
      return;
    }

    if (row.kind === "folder") {
      void navigate({
        to: "/drive/f/$folderId",
        params: { folderId: row.id },
        search: order,
      });
    } else {
      void navigate({
        to: "/drive/d/$nodeId",
        params: { nodeId: row.id },
        search: {},
      });
    }
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the row is a pointer shortcut for the name link inside it; keyboard users reach the link and the buttons in the row
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the list also holds the column header and the empty state, which an li's ul cannot
      role="listitem"
      data-node={row.id}
      className={cx(
        "group/row flex h-10 items-center gap-3 border-b border-line px-4 text-base transition-colors duration-75",
        selected ? "bg-selected" : "hover:bg-hover"
      )}
      onClick={(e) => {
        if (
          e.target instanceof Element &&
          e.target.closest("a, button, input, [role=menu]")
        ) {
          return;
        }

        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          open();
        }
      }}
    >
      <Checkbox
        aria-label={`Select ${row.name}`}
        checked={selected}
        onChange={(e) =>
          onSelect(
            e.currentTarget.checked,
            e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey
          )
        }
        onClick={(e) => e.stopPropagation()}
      />
      <KindIcon
        kind={row.kind}
        name={row.name}
        contentType={row.contentType}
        className="h-4 w-4"
      />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <NodeName row={row} order={order} inTrash={inTrash} />
        {row.shared && row.role === "owner" && (
          <Users
            className="text-subtle h-3.5 w-3.5 shrink-0"
            aria-label="Shared"
          />
        )}
        {row.linked && (
          <Link2
            className="text-subtle h-3.5 w-3.5 shrink-0"
            aria-label="Shared outside the workspace"
          />
        )}
        {row.starred && (
          <Star
            className="fill-star text-star h-3 w-3 shrink-0"
            aria-label="Starred"
          />
        )}
      </span>
      {showOwner && (
        <span className="text-muted hidden w-32 truncate text-sm @2xl:block">
          {row.role === "owner" ? "me" : row.owner.name}
        </span>
      )}
      <Timestamp
        iso={row.trashedAt ?? row.updatedAt}
        className="text-subtle hidden w-24 text-sm @xl:block"
      />
      <span className="tnum text-subtle w-16 text-right text-sm">
        {row.kind === "file" ? formatSize(row.size) : "–"}
      </span>
      <span className="flex w-[76px] items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        {!inTrash && (
          <IconButton
            size="sm"
            label={row.starred ? "Unstar" : "Star"}
            onClick={onStar}
          >
            <Star
              className={cx(
                "h-3.5 w-3.5",
                row.starred && "fill-star text-star"
              )}
            />
          </IconButton>
        )}
        {!inTrash && row.kind === "file" && (
          <a
            href={`/api/drive/files/${row.id}?download=1`}
            className="text-muted hover:bg-hover hover:text-fg inline-flex h-6 w-6 items-center justify-center rounded-md"
            aria-label={`Download ${row.name}`}
            title="Download"
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
        <Menu
          label={`Actions for ${row.name}`}
          renderTrigger={({ toggle, open: isOpen }) => (
            <IconButton
              size="sm"
              label="More"
              onClick={toggle}
              active={isOpen}
              aria-haspopup="menu"
              aria-expanded={isOpen}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </IconButton>
          )}
        >
          <RowMenuItems
            row={row}
            inTrash={inTrash}
            onOpen={open}
            onStar={onStar}
            onRename={onRename}
            onMove={onMove}
            onShare={onShare}
            onTrash={onTrash}
            onRestore={onRestore}
            onDelete={onDelete}
          />
        </Menu>
      </span>
    </div>
  );
};

const EmptyState = ({
  view,
  searching,
  folder,
  canWrite,
  onUpload,
}: {
  view: DriveView;
  searching: boolean;
  folder: boolean;
  canWrite: boolean;
  onUpload: () => void;
}) => {
  if (searching) {
    return (
      <Empty icon={<Search className="h-4 w-4" />} title="Nothing found">
        No file or folder has those words in its name.
      </Empty>
    );
  }

  if (folder || view === "mine") {
    return (
      <Empty
        icon={<HardDrive className="h-4 w-4" />}
        title={folder ? "This folder is empty" : "Your drive is empty"}
        action={
          canWrite ? (
            <Button variant="primary" onClick={onUpload}>
              <Upload className="h-3.5 w-3.5" />
              Upload files
            </Button>
          ) : undefined
        }
      >
        {canWrite
          ? "Drop files here, or make a folder with New."
          : "Nothing has been put here yet."}
      </Empty>
    );
  }

  if (view === "shared") {
    return (
      <Empty
        icon={<Users className="h-4 w-4" />}
        title="Nothing shared with you"
      >
        A folder or file a colleague shares with you, or with everyone, shows up
        here.
      </Empty>
    );
  }

  if (view === "recent") {
    return (
      <Empty icon={<HardDrive className="h-4 w-4" />} title="Nothing recent">
        The files you worked with last show up here.
      </Empty>
    );
  }

  if (view === "starred") {
    return (
      <Empty icon={<Star className="h-4 w-4" />} title="Nothing starred">
        Star a file or folder to find it here.
      </Empty>
    );
  }

  return (
    <Empty icon={<Trash2 className="h-4 w-4" />} title="The trash is empty">
      What you trash waits here for {DRIVE_EXPIRY_DAYS} days before it is
      deleted.
    </Empty>
  );
};

/** Whether the listing names who owns each row: whenever the rows are not all the person's own. */
const showsOwner = ({ view, q, folder }: DriveListData) =>
  !!q ||
  view === "shared" ||
  view === "recent" ||
  view === "starred" ||
  (!!folder && folder.role !== "owner");

const titleOf = ({ q, folder, view }: DriveListData) => {
  if (q) {
    return "Search";
  }

  return folder?.name ?? DRIVE_VIEW_LABEL[view];
};

/** The view a breadcrumb trail starts from: the open folder's own, or the view itself. */
const rootViewOf = ({ folder, view }: DriveListData): DriveView => {
  if (!folder) {
    return view;
  }

  return folder.role === "owner" ? "mine" : "shared";
};

const rootSearchOf = (rootView: DriveView, data: DriveListData) =>
  rootView === "mine"
    ? { ...orderSearch(data) }
    : { view: rootView, ...orderSearch(data) };

type SetDialog = Dispatch<SetStateAction<DialogState>>;

/** What the listing's shortcuts, toolbar and menus do to rows: each takes the ids it acts on. */
const useRowActions = (rows: DriveRow[], setDialog: SetDialog) => {
  const selection = useSelection();
  const run = useDriveAction();

  const rowsOf = (someIds: string[]) =>
    rows.filter((r) => someIds.includes(r.id));

  const runOn = (intent: string, someIds: string[]) => {
    if (!someIds.length) {
      return;
    }

    void run(
      { intent, ids: JSON.stringify(someIds) },
      { after: () => selection.clear() }
    );
  };

  const trash = (someIds: string[]) => runOn("trash", someIds);
  const restore = (someIds: string[]) => runOn("restore", someIds);

  const deleteForever = (someIds: string[]) => {
    if (!someIds.length) {
      return;
    }

    const n = someIds.length;

    if (
      // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
      !confirm(
        `Delete ${n === 1 ? "this" : `these ${n}`} forever? This cannot be undone.`
      )
    ) {
      return;
    }

    runOn("delete", someIds);
  };

  const star = (someIds: string[]) => {
    const picked = rowsOf(someIds);

    if (!picked.length) {
      return;
    }

    const on = !picked.every((r) => r.starred);
    void run(
      { intent: on ? "star" : "unstar", ids: JSON.stringify(someIds) },
      { quiet: true }
    );
  };

  const rename = (someIds: string[]) => {
    const [row] = rowsOf(someIds);

    if (row && canEdit(row.role) && someIds.length === 1) {
      setDialog({ kind: "rename", row });
    }
  };

  const move = (someIds: string[]) => {
    const picked = rowsOf(someIds);

    if (picked.length && picked.every((r) => canEdit(r.role))) {
      setDialog({ kind: "move", ids: someIds });
    }
  };

  const emptyTrash = () => {
    // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
    if (!confirm("Empty the trash? Everything in it is deleted forever.")) {
      return;
    }

    void run({ intent: "empty-trash" });
  };

  return {
    rowsOf,
    trash,
    restore,
    deleteForever,
    star,
    rename,
    move,
    emptyTrash,
  };
};

/** The header's tools when nothing is selected: search, order, New and the list's own menu. */
const ListActions = ({
  data,
  folderId,
  inTrash,
  onNewFolder,
  onPickFiles,
  onPickFolder,
  onSelectAll,
  onEmptyTrash,
}: {
  data: DriveListData;
  folderId: string | null;
  inTrash: boolean;
  onNewFolder: () => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onSelectAll: () => void;
  onEmptyTrash: () => void;
}) => (
  <>
    <SearchField
      action="/drive"
      label="Search Drive"
      placeholder="Search Drive"
      value={data.q}
      className="@2xl:w-40 @3xl:w-60"
      clear={
        <Link
          to="/drive"
          search={{}}
          className={searchClearClass}
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </Link>
      }
    />
    <SortMenu data={data} folderId={folderId} />
    {data.canWrite && (
      <Menu
        label="New"
        renderTrigger={({ toggle, open }) => (
          <Button
            variant="primary"
            size="md"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New
          </Button>
        )}
      >
        <MenuItem
          icon={<FolderPlus className="h-3.5 w-3.5" />}
          onClick={onNewFolder}
        >
          New folder
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<Upload className="h-3.5 w-3.5" />}
          onClick={onPickFiles}
        >
          Upload files
        </MenuItem>
        <MenuItem
          icon={<FolderInput className="h-3.5 w-3.5" />}
          onClick={onPickFolder}
        >
          Upload folder
        </MenuItem>
      </Menu>
    )}
    <Menu
      label="List actions"
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
      <MenuItem
        icon={<CheckSquare className="h-3.5 w-3.5" />}
        onClick={onSelectAll}
      >
        Select all
      </MenuItem>
      {inTrash && (
        <>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onEmptyTrash}
          >
            Empty trash now
          </MenuItem>
        </>
      )}
    </Menu>
  </>
);

/** The sortable column titles above the rows; nothing when there are no rows. */
const ColumnHeader = ({
  data,
  folderId,
  showOwner,
}: {
  data: DriveListData;
  folderId: string | null;
  showOwner: boolean;
}) => {
  if (!data.rows.length) {
    return null;
  }

  return (
    <div className="border-line text-subtle flex h-8 items-center gap-3 border-b px-4 text-xs font-medium">
      <span className="w-3.5" />
      <span className="w-4" />
      <SortHeader
        data={data}
        folderId={folderId}
        column="name"
        className="flex-1"
      >
        Name
      </SortHeader>
      {showOwner && <span className="hidden w-32 @2xl:block">Owner</span>}
      <SortHeader
        data={data}
        folderId={folderId}
        column="updated"
        className="hidden w-24 @xl:block"
      >
        Modified
      </SortHeader>
      <SortHeader
        data={data}
        folderId={folderId}
        column="size"
        className="w-16 text-right"
      >
        Size
      </SortHeader>
      <span className="w-[76px]" />
    </div>
  );
};

/** What shows over the listing while files are dragged onto it. */
const DropHint = ({ folder }: { folder: DriveFolderHead | null }) => (
  <div className="bg-bg/80 animate-fade-in pointer-events-none absolute inset-0 z-20 flex items-center justify-center backdrop-blur-[1px]">
    <div className="border-accent bg-accent-soft text-md text-accent rounded-lg border-2 border-dashed px-6 py-4 font-medium">
      Drop files to upload to {folder?.name ?? "My Drive"}
    </div>
  </div>
);

/** The dialogs a row or the header opens: the one that is open shows, the rest stay closed. */
const BrowserDialogs = ({
  dialog,
  folderId,
  onClose,
}: {
  dialog: DialogState;
  folderId: string | null;
  onClose: () => void;
}) => {
  const run = useDriveAction();
  const { clear } = useSelection();
  const renaming = dialog?.kind === "rename" ? dialog.row : null;
  const moving = dialog?.kind === "move" ? dialog.ids : null;
  const sharing = dialog?.kind === "share" ? dialog.row : null;

  return (
    <>
      <NameDialog
        open={dialog?.kind === "folder"}
        title="New folder"
        submitLabel="Create"
        onClose={onClose}
        onSubmit={async (name) => {
          const r = await run(
            { intent: "folder", parent: folderId ?? "", name },
            { quiet: true }
          );

          return !!r?.ok;
        }}
      />
      <NameDialog
        open={renaming !== null}
        title="Rename"
        initial={renaming?.name ?? ""}
        submitLabel="Rename"
        onClose={onClose}
        onSubmit={async (name) => {
          if (!renaming) {
            return false;
          }

          const r = await run(
            { intent: "rename", id: renaming.id, name },
            { quiet: true }
          );

          return !!r?.ok;
        }}
      />
      <MoveDialog
        open={moving !== null}
        ids={moving ?? []}
        currentId={folderId}
        onClose={onClose}
        onMoved={() => clear()}
      />
      <ShareDialog open={sharing !== null} node={sharing} onClose={onClose} />
    </>
  );
};

/**
 * A listing of Drive: the open folder or a view (Shared with me, Recent, Starred, Trash, a search), folders first,
 * a row per node with its kind, owner, time and size, a checkbox each for the selection, and the actions that show
 * on hover. Files dropped on it upload into the open folder.
 */
export const DriveBrowser = ({ data }: { data: DriveListData }) => {
  const { view, q, folder, crumbs, rows, canWrite } = data;
  const list = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const selection = useSelection();
  const navigate = useNavigate();
  const uploads = useUploads();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dragging, setDragging] = useState(false);
  const lastPick = useRef<string | null>(null);

  const {
    rowsOf,
    trash,
    restore,
    deleteForever,
    star,
    rename,
    move,
    emptyTrash,
  } = useRowActions(rows, setDialog);

  useListNavigation(list);

  const folderId = folder?.id ?? null;
  const inTrash = view === "trash" && !q;
  const searching = !!q;
  const showOwner = showsOwner(data);

  // The selection is of this listing; another folder or view starts it over.
  const key = `${view}|${folderId ?? ""}|${q}`;
  const { clear } = selection;
  const clearedFor = useRef<string | null>(null);
  useEffect(() => {
    if (clearedFor.current !== key) {
      clearedFor.current = key;
      clear();
    }
  }, [key, clear]);

  const ids = rows.map((r) => r.id);
  const chosen = ids.filter((id) => selection.isSelected(id));
  const chosenRows = rowsOf(chosen);
  const allChosen = ids.length > 0 && chosen.length === ids.length;

  /** What a shortcut acts on: the selection, else the row that has the focus. */
  const targets = () => {
    if (chosen.length) {
      return chosen;
    }

    const id = focusedNodeId();

    return id ? [id] : [];
  };

  const pickFiles = () => canWrite && fileInput.current?.click();
  const pickFolder = () => canWrite && folderInput.current?.click();

  const up = () => {
    if (!folder) {
      return;
    }

    const parent = crumbs.at(-1);

    if (parent) {
      void navigate({
        to: "/drive/f/$folderId",
        params: { folderId: parent.id },
        search: orderSearch(data),
      });
    } else {
      void navigate({
        to: "/drive",
        search:
          folder.role === "owner"
            ? orderSearch(data)
            : { view: "shared", ...orderSearch(data) },
      });
    }
  };

  useShortcuts([
    {
      keys: "x",
      run: () => {
        const id = focusedNodeId();

        if (id) {
          selection.toggle(id);
        }
      },
    },
    { keys: "* a", run: () => selection.set(ids) },
    { keys: "* n", run: () => selection.clear() },
    {
      keys: "#",
      run: () => (inTrash ? deleteForever(targets()) : trash(targets())),
    },
    {
      keys: "Delete",
      run: () => (inTrash ? deleteForever(targets()) : trash(targets())),
    },
    { keys: "s", run: () => !inTrash && star(targets()) },
    { keys: "r", run: () => !inTrash && rename(targets()) },
    { keys: "m", run: () => !inTrash && move(targets()) },
    { keys: "n", run: () => canWrite && setDialog({ kind: "folder" }) },
    { keys: "u", run: pickFiles },
    { keys: "Backspace", run: up },
  ]);

  const onFiles = (chosenFiles: FileList | null) => {
    const files = [...(chosenFiles ?? [])].filter((f) => f.size > 0 || f.name);

    if (files.length && canWrite) {
      uploads.add(files, folderId);
    }
  };

  const title = titleOf(data);
  const rootView = rootViewOf(data);
  const rootSearch = rootSearchOf(rootView, data);

  return (
    <div
      className="print-hidden @container relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes("Files")) {
          return;
        }

        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget;

        if (!(next instanceof Node && e.currentTarget.contains(next))) {
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        setDragging(false);

        if (!canWrite || !e.dataTransfer.files.length) {
          return;
        }

        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
    >
      <ViewHeader
        title={
          chosen.length ? (
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span className="tnum">{chosen.length}</span>
              <IconButton
                size="sm"
                label="Clear selection"
                onClick={() => selection.clear()}
              >
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </span>
          ) : (
            <Crumbs
              rootView={rootView}
              rootSearch={rootSearch}
              crumbs={searching ? [] : crumbs}
              title={title}
              order={orderSearch(data)}
              linked={!searching && !!folder?.linked}
            />
          )
        }
        count={chosen.length ? undefined : rows.length}
        left={
          rows.length > 0 ? (
            <Checkbox
              aria-label={allChosen ? "Select none" : "Select all"}
              checked={allChosen}
              ref={(el) => {
                if (el) {
                  el.indeterminate = chosen.length > 0 && !allChosen;
                }
              }}
              onChange={(e) =>
                e.currentTarget.checked ? selection.set(ids) : selection.clear()
              }
              className="mr-1"
            />
          ) : undefined
        }
      >
        {chosen.length ? (
          <BulkToolbar
            rows={chosenRows}
            inTrash={inTrash}
            onStar={() => star(chosen)}
            onRename={() => rename(chosen)}
            onMove={() => move(chosen)}
            onShare={() =>
              chosenRows[0] && setDialog({ kind: "share", row: chosenRows[0] })
            }
            onTrash={() => trash(chosen)}
            onRestore={() => restore(chosen)}
            onDelete={() => deleteForever(chosen)}
          />
        ) : (
          <ListActions
            data={data}
            folderId={folderId}
            inTrash={inTrash}
            onNewFolder={() => setDialog({ kind: "folder" })}
            onPickFiles={pickFiles}
            onPickFolder={pickFolder}
            onSelectAll={() => selection.set(ids)}
            onEmptyTrash={emptyTrash}
          />
        )}
      </ViewHeader>

      {inTrash && rows.length > 0 && (
        <div className="border-line bg-sidebar text-muted flex h-8 shrink-0 items-center border-b px-4 text-sm">
          Things in the trash for more than {DRIVE_EXPIRY_DAYS} days are deleted
          forever.
        </div>
      )}

      <div
        ref={list}
        className="flex-1 overflow-y-auto"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the list holds the column header and the empty state beside its rows, which a ul cannot
        role="list"
        aria-label={title}
      >
        <ColumnHeader data={data} folderId={folderId} showOwner={showOwner} />
        {rows.map((row) => (
          <NodeRow
            key={row.id}
            row={row}
            order={orderSearch(data)}
            inTrash={inTrash}
            showOwner={showOwner}
            selected={selection.isSelected(row.id)}
            onSelect={(on, range) => {
              if (range && lastPick.current) {
                const a = ids.indexOf(lastPick.current);
                const b = ids.indexOf(row.id);

                if (a !== -1 && b !== -1) {
                  const [lo, hi] = a < b ? [a, b] : [b, a];

                  for (const id of ids.slice(lo, hi + 1)) {
                    selection.toggle(id, on);
                  }

                  return;
                }
              }

              selection.toggle(row.id, on);
              lastPick.current = row.id;
            }}
            onStar={() => star([row.id])}
            onRename={() => rename([row.id])}
            onMove={() => move([row.id])}
            onShare={() => setDialog({ kind: "share", row })}
            onTrash={() => trash([row.id])}
            onRestore={() => restore([row.id])}
            onDelete={() => deleteForever([row.id])}
          />
        ))}
        {!rows.length && (
          <EmptyState
            view={view}
            searching={searching}
            folder={!!folder}
            canWrite={canWrite}
            onUpload={pickFiles}
          />
        )}
      </div>

      {dragging && <DropHint folder={folder} />}

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

      <BrowserDialogs
        dialog={dialog}
        folderId={folderId}
        onClose={() => setDialog(null)}
      />
    </div>
  );
};
