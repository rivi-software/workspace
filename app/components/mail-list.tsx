import {
  Link,
  useHydrated,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Archive,
  ArchiveRestore,
  BellOff,
  CalendarClock,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

import { withCleanup } from "~/lib/cleanup";
import { folderAction, quickLabel, unscheduleAction } from "~/lib/mail/actions";
import { FOLDER_LABEL } from "~/lib/mail/folders";
import type { Folder, LabelRef } from "~/lib/mail/folders";
import type { DraftRow, ListRow, MailListData } from "~/lib/mail/reads";
import { snoozeLabel } from "~/lib/mail/snooze";
import type { ThreadAction } from "~/lib/mail/views";

import { useListNavigation, useShortcuts } from "./keyboard";
import { LabelChip, LabelPicker, LabelTriggerButton } from "./labels";
import { useLeaving } from "./mail-leaving";
import { useSelection } from "./mail-selection";
import { SnoozeMenu, SnoozeTriggerButton } from "./snooze-menu";
import { useToast } from "./toast";
import {
  Button,
  Checkbox,
  Empty,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  SearchField,
  Timestamp,
  ViewHeader,
  cx,
  searchClearClass,
} from "./ui";
import { useThreadActions } from "./use-thread-actions";

interface ListSearch {
  folder?: string;
  q?: string;
  page?: string;
  label?: string;
}

/** The search params of the list as links keep them: the folder or label, the search, and the page. */
export const listParams = (data: MailListData, page?: number): ListSearch => {
  const out: ListSearch = {};

  if (data.label) {
    out.label = data.label.id;
  } else if (data.folder !== "inbox") {
    out.folder = data.folder;
  }

  if (data.q) {
    out.q = data.q;
  }

  const p = page ?? data.page;

  if (p > 1) {
    out.page = String(p);
  }

  return out;
};

/**
 * A scheduled message: who it goes to, when (in the reader's time zone), and "Cancel send", which makes it a draft
 * again and opens it, as Gmail does. It is not opened as it stands: an edit could race the cron sending it.
 */
const ScheduledRow = ({ draft: d }: { draft: DraftRow }) => {
  const unschedule = useServerFn(unscheduleAction);
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // In the reader's time zone, so only once hydrated: the server's UTC text would stay after hydration.
  const hydrated = useHydrated();
  const when = hydrated && d.scheduledAt ? snoozeLabel(d.scheduledAt) : "";

  const cancel = async () => {
    setBusy(true);

    await withCleanup(
      async () => {
        const { ok } = await unschedule({ data: { draftId: d.id } });
        await router.invalidate();

        if (!ok) {
          toast.show({
            message: "It was sent already, or deleted.",
            tone: "error",
          });

          return;
        }

        toast.show({
          message: "Send cancelled. The message is a draft again.",
        });
        navigate({ to: "/mail/compose", search: { draft: d.id } });
      },
      () => setBusy(false)
    );
  };

  return (
    <div
      data-row
      className="group/row border-line flex min-h-10 items-center gap-3 border-b px-4 py-2 text-base"
    >
      <CalendarClock className="text-subtle h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-fg truncate">
            {d.subject || "(no subject)"}
          </span>
          {d.scheduledAt && (
            <span className="tnum text-accent ml-auto shrink-0 text-sm">
              {when}
            </span>
          )}
        </span>
        <span className="text-muted block truncate text-sm">
          {d.to ? `To ${d.to}` : "(no recipients)"}
          {d.snippet && <span className="text-subtle"> – {d.snippet}</span>}
        </span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={() => {
          cancel();
        }}
      >
        Cancel send
      </Button>
    </div>
  );
};

const PageLink = ({
  data,
  page,
  disabled,
  label,
  children,
}: {
  data: MailListData;
  page: number;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) => {
  if (disabled) {
    return (
      <span
        aria-disabled
        className="text-faint inline-flex h-7 w-7 items-center justify-center rounded-md"
      >
        {children}
      </span>
    );
  }

  return (
    <Link
      to="/mail"
      search={listParams(data, page)}
      aria-label={label}
      title={label}
      className="text-muted hover:bg-hover hover:text-fg inline-flex h-7 w-7 items-center justify-center rounded-md"
    >
      {children}
    </Link>
  );
};

const BulkToolbar = ({
  folder,
  labels,
  labelState,
  labelOpen,
  setLabelOpen,
  snoozeOpen,
  setSnoozeOpen,
  onAction,
  onCreateLabel,
}: {
  folder: Folder;
  labels: LabelRef[];
  labelState: Map<string, "all" | "some">;
  labelOpen: boolean;
  setLabelOpen: (o: boolean) => void;
  snoozeOpen: boolean;
  setSnoozeOpen: (o: boolean) => void;
  onAction: (a: ThreadAction) => void;
  onCreateLabel: (name: string) => Promise<LabelRef | null>;
}) => {
  const inJunk = folder === "trash" || folder === "spam";

  return (
    <>
      {inJunk ? (
        <IconButton
          label="Move to inbox (e)"
          onClick={() => onAction({ intent: "inbox" })}
        >
          <ArchiveRestore className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton
          label="Archive (e)"
          onClick={() => onAction({ intent: "archive" })}
        >
          <Archive className="h-4 w-4" />
        </IconButton>
      )}
      {folder === "spam" ? (
        <IconButton
          label="Not spam (!)"
          onClick={() => onAction({ intent: "inbox" })}
        >
          <ShieldCheck className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton
          label="Mark as spam (!)"
          onClick={() => onAction({ intent: "spam" })}
        >
          <ShieldAlert className="h-4 w-4" />
        </IconButton>
      )}
      {folder !== "trash" && (
        <IconButton
          label="Move to trash (#)"
          onClick={() => onAction({ intent: "trash" })}
        >
          <Trash2 className="h-4 w-4" />
        </IconButton>
      )}
      <span className="bg-line mx-0.5 hidden h-4 w-px @3xl:block" />
      <IconButton
        label="Mark as read (I)"
        onClick={() => onAction({ intent: "read" })}
        className="hidden @3xl:inline-flex"
      >
        <MailOpen className="h-4 w-4" />
      </IconButton>
      <IconButton
        label="Mark as unread (U)"
        onClick={() => onAction({ intent: "unread" })}
        className="hidden @3xl:inline-flex"
      >
        <Mail className="h-4 w-4" />
      </IconButton>
      <IconButton
        label="Star (s)"
        onClick={() => onAction({ intent: "star" })}
        className="hidden @3xl:inline-flex"
      >
        <Star className="h-4 w-4" />
      </IconButton>
      {!inJunk && (
        <SnoozeMenu
          onPick={(until) => onAction({ intent: "snooze", until })}
          renderTrigger={({ open, toggle }) => (
            <SnoozeTriggerButton
              open={open || snoozeOpen}
              toggle={() => {
                setSnoozeOpen(false);
                toggle();
              }}
            />
          )}
        />
      )}
      <LabelPicker
        labels={labels}
        state={labelState}
        onToggle={(l, on) =>
          onAction({ intent: on ? "label" : "unlabel", labelId: l.id })
        }
        onCreate={onCreateLabel}
        open={labelOpen || undefined}
        onOpenChange={(o) => !o && setLabelOpen(false)}
        renderTrigger={({ open, toggle }) => (
          <LabelTriggerButton open={open} toggle={toggle} />
        )}
      />
      <IconButton
        label="Mute (m)"
        onClick={() => onAction({ intent: "mute" })}
        className="hidden @3xl:inline-flex"
      >
        <BellOff className="h-4 w-4" />
      </IconButton>
      {inJunk && (
        <Button
          size="sm"
          variant="ghost"
          className="text-red hover:text-red hidden @3xl:inline-flex"
          onClick={() => {
            if (
              // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
              confirm(
                "Delete these conversations forever? Their messages and files cannot be recovered."
              )
            ) {
              onAction({ intent: "delete" });
            }
          }}
        >
          Delete forever
        </Button>
      )}
      <Menu
        label="More actions"
        className="@3xl:hidden"
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
          icon={<MailOpen className="h-3.5 w-3.5" />}
          onClick={() => onAction({ intent: "read" })}
        >
          Mark as read
        </MenuItem>
        <MenuItem
          icon={<Mail className="h-3.5 w-3.5" />}
          onClick={() => onAction({ intent: "unread" })}
        >
          Mark as unread
        </MenuItem>
        <MenuItem
          icon={<Star className="h-3.5 w-3.5" />}
          onClick={() => onAction({ intent: "star" })}
        >
          Star
        </MenuItem>
        <MenuItem
          icon={<BellOff className="h-3.5 w-3.5" />}
          onClick={() => onAction({ intent: "mute" })}
        >
          Mute
        </MenuItem>
        {inJunk && (
          <>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => {
                if (
                  // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                  confirm(
                    "Delete these conversations forever? Their messages and files cannot be recovered."
                  )
                ) {
                  onAction({ intent: "delete" });
                }
              }}
            >
              Delete forever
            </MenuItem>
          </>
        )}
      </Menu>
    </>
  );
};

const RowTime = ({
  thread: t,
  folder,
  className,
}: {
  thread: ListRow;
  folder: Folder;
  className?: string;
}) => {
  // In the reader's time zone, so only once hydrated, as `Timestamp` does.
  const hydrated = useHydrated();

  if (t.snoozedUntil && (folder === "snoozed" || folder === "archive")) {
    return (
      <span
        className={cx("tnum whitespace-nowrap text-sm text-amber", className)}
        title="Snoozed"
      >
        {hydrated && snoozeLabel(t.snoozedUntil)}
      </span>
    );
  }

  return (
    <Timestamp
      iso={t.lastMessageAt}
      className={cx(
        "text-sm",
        t.unread ? "font-semibold text-fg" : "text-subtle",
        className
      )}
    />
  );
};

/** A row's background: the open one, a selected one, an unread one, else none. */
const rowTone = (
  active: boolean,
  selected: boolean,
  unread: boolean
): string => {
  if (active) {
    return "bg-selected";
  }

  if (selected) {
    return "bg-accent-soft/60";
  }

  return unread ? "bg-unread" : "bg-transparent";
};

const ThreadRow = ({
  thread: t,
  data,
  active,
  selected,
  onSelect,
  onAction,
  onOpen,
}: {
  thread: ListRow;
  data: MailListData;
  active: boolean;
  selected: boolean;
  onSelect: (on: boolean, range: boolean) => void;
  onAction: (a: ThreadAction) => void;
  onOpen: () => void;
}) => {
  const { folder } = data;
  const inJunk = folder === "trash" || folder === "spam";
  const search = listParams(data);
  const people = t.people || "me";

  return (
    <div
      data-thread={t.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the rows sit in a `div role="list"` that also holds the paging footer, which a `ul` could not
      role="listitem"
      aria-current={active ? "page" : undefined}
      className={cx(
        "group/row relative flex items-start gap-2 border-b border-line pl-3 pr-3 text-base transition-colors duration-75 hover:bg-hover @3xl:h-10 @3xl:items-center @3xl:gap-3 @3xl:pr-4",
        rowTone(active, selected, t.unread)
      )}
    >
      <span className="flex shrink-0 items-center gap-1 pt-2.5 @3xl:pt-0">
        <Checkbox
          checked={selected}
          aria-label={`Select ${t.subject}`}
          onClick={(e) => onSelect(!selected, e.shiftKey)}
          readOnly
        />
        <button
          type="button"
          onClick={() => onAction({ intent: t.starred ? "unstar" : "star" })}
          aria-label={t.starred ? "Unstar" : "Star"}
          aria-pressed={t.starred}
          className={cx(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-active",
            t.starred ? "text-star" : "text-faint hover:text-muted"
          )}
        >
          <Star
            className="h-3.5 w-3.5"
            fill={t.starred ? "currentColor" : "none"}
          />
        </button>
      </span>
      <Link
        to="/mail/t/$threadId"
        params={{ threadId: t.id }}
        search={search}
        data-row
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
          }

          e.preventDefault();
          onOpen();
        }}
        className="flex min-w-0 flex-1 flex-col py-2 focus:outline-none focus-visible:underline @3xl:flex-row @3xl:items-center @3xl:gap-3 @3xl:self-stretch @3xl:py-0"
      >
        <span className="flex min-w-0 items-center gap-2 @3xl:w-44 @3xl:shrink-0">
          <span
            className={cx(
              "min-w-0 flex-1 truncate",
              t.unread ? "font-semibold text-fg" : "text-muted"
            )}
          >
            {people}
            {t.count > 1 && (
              <span className="tnum text-subtle ml-1 text-xs font-normal">
                {t.count}
              </span>
            )}
          </span>
          {t.muted && (
            <BellOff
              className="text-subtle h-3 w-3 shrink-0"
              aria-label="Muted"
            />
          )}
          <RowTime
            thread={t}
            folder={folder}
            className="shrink-0 @3xl:hidden"
          />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">
            <span className={t.unread ? "text-fg font-semibold" : "text-fg"}>
              {t.subject}
            </span>
            <span className="text-subtle hidden @3xl:inline">
              {" "}
              – {t.snippet}
            </span>
          </span>
          {t.labels.length > 0 && (
            <span className="hidden shrink-0 items-center gap-1 @3xl:flex">
              {t.labels.slice(0, 3).map((l) => (
                <LabelChip key={l.id} label={l} size="xs" />
              ))}
            </span>
          )}
          {t.hasAttachments && (
            <Paperclip
              className="text-subtle h-3.5 w-3.5 shrink-0"
              aria-label="Has attachments"
            />
          )}
        </span>
        <span className="text-subtle flex items-center gap-1.5 text-sm @3xl:hidden">
          {t.labels.slice(0, 2).map((l) => (
            <LabelChip key={l.id} label={l} size="xs" />
          ))}
          <span className="min-w-0 truncate">{t.snippet}</span>
        </span>
        <RowTime
          thread={t}
          folder={folder}
          className="hidden w-14 shrink-0 text-right @3xl:block"
        />
      </Link>
      <div className="bg-elevated shadow-pop absolute top-1.5 right-3 hidden items-center gap-0.5 rounded-md p-0.5 group-focus-within/row:flex group-hover/row:flex @3xl:top-auto">
        {inJunk ? (
          <IconButton
            size="sm"
            label="Move to inbox"
            onClick={() => onAction({ intent: "inbox" })}
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
          </IconButton>
        ) : (
          <IconButton
            size="sm"
            label="Archive"
            onClick={() => onAction({ intent: "archive" })}
          >
            <Archive className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {folder !== "trash" && (
          <IconButton
            size="sm"
            label="Move to trash"
            onClick={() => onAction({ intent: "trash" })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton
          size="sm"
          label={t.unread ? "Mark as read" : "Mark as unread"}
          onClick={() => onAction({ intent: t.unread ? "read" : "unread" })}
        >
          {t.unread ? (
            <MailOpen className="h-3.5 w-3.5" />
          ) : (
            <Mail className="h-3.5 w-3.5" />
          )}
        </IconButton>
        {!inJunk && (
          <SnoozeMenu
            onPick={(until) => onAction({ intent: "snooze", until })}
            renderTrigger={({ open, toggle }) => (
              <IconButton
                size="sm"
                label="Snooze"
                onClick={toggle}
                active={open}
                aria-haspopup="dialog"
              >
                <Clock className="h-3.5 w-3.5" />
              </IconButton>
            )}
          />
        )}
      </div>
    </div>
  );
};

/** Drafts and scheduled messages are drafts, not conversations: no selection, pages or folder actions. */
const isDraftsView = (folder: Folder): boolean =>
  folder === "drafts" || folder === "scheduled";

const listTitle = ({ label, q, folder }: MailListData): string => {
  if (label) {
    return label.name;
  }

  return q ? "Search" : FOLDER_LABEL[folder];
};

/** The conversation whose row has the focus, if any. */
const focusedId = (): string | null =>
  document.activeElement?.closest<HTMLElement>("[data-thread]")?.dataset
    .thread ?? null;

/** Per label: on all the chosen conversations or only some of them. */
const labelStateOf = (
  threads: ListRow[],
  chosen: string[],
  labels: LabelRef[]
): Map<string, "all" | "some"> => {
  const rows = threads.filter((t) => chosen.includes(t.id));
  const state = new Map<string, "all" | "some">();

  for (const l of labels) {
    const n = rows.filter((r) => r.labels.some((x) => x.id === l.id)).length;

    if (n === rows.length && n > 0) {
      state.set(l.id, "all");
    } else if (n > 0) {
      state.set(l.id, "some");
    }
  }

  return state;
};

const emptyHint = ({ q, folder }: MailListData): string => {
  if (q) {
    return "No conversation matches that search. Try from:, to:, subject:, has:attachment, is:unread, label:, before: or after:.";
  }

  if (folder === "inbox") {
    return "New mail lands here the moment it arrives.";
  }

  return folder === "snoozed"
    ? "A snoozed conversation waits here until its time comes."
    : "";
};

const emptyTitle = ({ q, label, folder }: MailListData): string => {
  if (q) {
    return "Nothing found";
  }

  return label
    ? `Nothing labelled ${label.name}`
    : `Nothing in ${FOLDER_LABEL[folder]}`;
};

const ListTitle = ({
  chosen,
  label,
  title,
  onClear,
}: {
  chosen: number;
  label: LabelRef | null;
  title: string;
  onClear: () => void;
}) => {
  if (chosen > 0) {
    return (
      <span className="flex items-center gap-2 whitespace-nowrap">
        <span className="tnum">{chosen}</span>
        <IconButton size="sm" label="Clear selection" onClick={onClear}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      {label && (
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: `var(--label-${label.color})` }}
        />
      )}
      {title}
    </span>
  );
};

/** The folder-wide actions: select the page, mark everything read, empty the trash or Spam. */
const ListMenu = ({
  folder,
  onSelectAll,
  onReadAll,
  onEmpty,
}: {
  folder: Folder;
  onSelectAll: () => void;
  onReadAll: () => void;
  onEmpty: () => void;
}) => (
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
      Select all on this page
    </MenuItem>
    <MenuItem icon={<MailOpen className="h-3.5 w-3.5" />} onClick={onReadAll}>
      Mark all as read
    </MenuItem>
    {(folder === "trash" || folder === "spam") && (
      <>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={onEmpty}
        >
          Empty {FOLDER_LABEL[folder].toLowerCase()} now
        </MenuItem>
      </>
    )}
  </Menu>
);

/** The header: the title or the selection's count, the search, the page and the folder menu, or the selection's toolbar. */
const ListHeader = ({
  data,
  threads,
  total,
  chosen,
  onClear,
  onSelectAll,
  labelOpen,
  setLabelOpen,
  snoozeOpen,
  setSnoozeOpen,
  onAction,
  onCreateLabel,
  onReadAll,
  onEmpty,
}: {
  data: MailListData;
  threads: ListRow[];
  total: number;
  chosen: string[];
  onClear: () => void;
  onSelectAll: () => void;
  labelOpen: boolean;
  setLabelOpen: (o: boolean) => void;
  snoozeOpen: boolean;
  setSnoozeOpen: (o: boolean) => void;
  onAction: (a: ThreadAction) => void;
  onCreateLabel: (name: string) => Promise<LabelRef | null>;
  onReadAll: () => void;
  onEmpty: () => void;
}) => {
  const { folder, q, label, drafts, page, pageSize } = data;
  const draftsView = isDraftsView(folder);
  const allChosen = threads.length > 0 && chosen.length === threads.length;
  const count = draftsView ? drafts.length : total;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <ViewHeader
      title={
        <ListTitle
          chosen={chosen.length}
          label={label}
          title={listTitle(data)}
          onClear={onClear}
        />
      }
      count={chosen.length ? undefined : count}
      left={
        !draftsView && threads.length > 0 ? (
          <Checkbox
            aria-label={allChosen ? "Select none" : "Select all"}
            checked={allChosen}
            ref={(el) => {
              if (el) {
                el.indeterminate = chosen.length > 0 && !allChosen;
              }
            }}
            onChange={(e) =>
              e.currentTarget.checked ? onSelectAll() : onClear()
            }
            className="mr-1"
          />
        ) : undefined
      }
    >
      {chosen.length ? (
        <BulkToolbar
          folder={folder}
          labels={data.labels}
          labelState={labelStateOf(threads, chosen, data.labels)}
          labelOpen={labelOpen}
          setLabelOpen={setLabelOpen}
          snoozeOpen={snoozeOpen}
          setSnoozeOpen={setSnoozeOpen}
          onAction={onAction}
          onCreateLabel={onCreateLabel}
        />
      ) : (
        <>
          <SearchField
            action="/mail"
            label="Search mail"
            placeholder="Search mail"
            hint="from: to: subject: has:attachment is:unread label: before: after:"
            value={q}
            hidden={label ? { label: label.id } : { folder }}
            className="@sm:w-40 @3xl:w-64"
            clear={
              <Link
                to="/mail"
                search={label ? { label: label.id } : { folder }}
                className={searchClearClass}
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {!draftsView && total > pageSize && (
            <span className="ml-1 hidden items-center gap-0.5 @2xl:flex">
              <span className="tnum text-subtle mr-1 text-sm">
                {from}–{to} of {total}
              </span>
              <PageLink
                data={data}
                page={page - 1}
                disabled={page <= 1}
                label="Newer"
              >
                <ChevronLeft className="h-4 w-4" />
              </PageLink>
              <PageLink
                data={data}
                page={page + 1}
                disabled={page >= pages}
                label="Older"
              >
                <ChevronRight className="h-4 w-4" />
              </PageLink>
            </span>
          )}
          {!draftsView && (
            <ListMenu
              folder={folder}
              onSelectAll={onSelectAll}
              onReadAll={onReadAll}
              onEmpty={onEmpty}
            />
          )}
        </>
      )}
    </ViewHeader>
  );
};

const ScheduledList = ({ drafts }: { drafts: DraftRow[] }) => {
  if (!drafts.length) {
    return (
      <Empty
        icon={<CalendarClock className="h-4 w-4" />}
        title="Nothing scheduled"
      >
        A message you send later waits here until it goes.
      </Empty>
    );
  }

  return drafts.map((d) => <ScheduledRow key={d.id} draft={d} />);
};

const DraftList = ({ drafts }: { drafts: DraftRow[] }) => {
  if (!drafts.length) {
    return (
      <Empty icon={<FileText className="h-4 w-4" />} title="No drafts">
        A message you are still writing waits here.
      </Empty>
    );
  }

  return drafts.map((d) => (
    <Link
      key={d.id}
      to="/mail/compose"
      search={{ draft: d.id }}
      data-row
      className="group/row border-line hover:bg-hover focus-visible:bg-hover flex min-h-10 items-center gap-3 border-b px-4 py-2 text-base focus:outline-none"
    >
      <FileText className="text-subtle h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-red mr-1">Draft</span>
          <span className="text-fg truncate">
            {d.subject || "(no subject)"}
          </span>
          <Timestamp
            iso={d.updatedAt}
            className="text-subtle ml-auto shrink-0 text-sm"
          />
        </span>
        <span className="text-muted block truncate text-sm">
          {d.to ? `To ${d.to}` : "(no recipients)"}
          {d.snippet && <span className="text-subtle"> – {d.snippet}</span>}
        </span>
        {d.sendError && (
          <span className="text-red block truncate text-sm">
            Not sent: {d.sendError}
          </span>
        )}
      </span>
    </Link>
  ));
};

/** The page's own "Newer, page n of m, Older" footer. */
const PageFooter = ({
  data,
  page,
  pages,
}: {
  data: MailListData;
  page: number;
  pages: number;
}) => (
  <div className="text-subtle flex items-center justify-center gap-2 py-3 text-sm">
    <PageLink data={data} page={page - 1} disabled={page <= 1} label="Newer">
      <ChevronLeft className="h-4 w-4" />
    </PageLink>
    <span className="tnum">
      Page {page} of {pages}
    </span>
    <PageLink
      data={data}
      page={page + 1}
      disabled={page >= pages}
      label="Older"
    >
      <ChevronRight className="h-4 w-4" />
    </PageLink>
  </div>
);

/** What the list holds: scheduled messages, drafts or conversations (or what says there are none), and the paging footer. */
const ListBody = ({
  ref,
  data,
  threads,
  total,
  activeId,
  isSelected,
  onPick,
  onAction,
  onOpen,
}: {
  ref: Ref<HTMLDivElement>;
  data: MailListData;
  threads: ListRow[];
  total: number;
  activeId: string | null;
  isSelected: (id: string) => boolean;
  onPick: (id: string, on: boolean, range: boolean) => void;
  onAction: (id: string, a: ThreadAction) => void;
  onOpen: (id: string) => void;
}) => {
  const { folder, drafts, page, pageSize } = data;
  const draftsView = isDraftsView(folder);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  let rows: ReactNode;

  if (folder === "scheduled") {
    rows = <ScheduledList drafts={drafts} />;
  } else if (folder === "drafts") {
    rows = <DraftList drafts={drafts} />;
  } else if (data.threads.length) {
    rows = threads.map((t) => (
      <ThreadRow
        key={t.id}
        thread={t}
        data={data}
        active={t.id === activeId}
        selected={isSelected(t.id)}
        onSelect={(on, range) => onPick(t.id, on, range)}
        onAction={(a) => onAction(t.id, a)}
        onOpen={() => onOpen(t.id)}
      />
    ));
  } else {
    rows = (
      <Empty icon={<InboxIcon className="h-4 w-4" />} title={emptyTitle(data)}>
        {emptyHint(data)}
      </Empty>
    );
  }

  return (
    <div
      ref={ref}
      className="flex-1 overflow-y-auto"
      role={draftsView ? undefined : "list"}
    >
      {rows}
      {!draftsView && total > pageSize && (
        <PageFooter data={data} page={page} pages={pages} />
      )}
    </div>
  );
};

/**
 * The thread list of a view: a row per conversation with its people, subject, snippet, labels and time, a
 * checkbox each for the selection, and the actions that show on hover. The header carries the search, the
 * selection toolbar, the page and a menu of folder-wide actions.
 */
export const MailList = ({
  data,
  activeId,
  navigation = true,
}: {
  data: MailListData;
  activeId: string | null;
  /** Whether j and k walk this list (off while an open conversation owns them). */
  navigation?: boolean;
}) => {
  const { folder, q, label, page } = data;
  const list = useRef<HTMLDivElement>(null);
  const selection = useSelection();
  const leaving = useLeaving();
  // What an action is taking out of this view is gone from it already, the count included.
  const threads = data.threads.filter((t) => !leaving.has(t.id));
  const total = data.total - (data.threads.length - threads.length);
  const run = useThreadActions();
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const folderFn = useServerFn(folderAction);
  const makeLabel = useServerFn(quickLabel);
  const [labelOpen, setLabelOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const lastPick = useRef<string | null>(null);
  useListNavigation(list, navigation);

  // The selection is of this page; a new page or view starts it over.
  const pageKey = `${folder}|${label?.id ?? ""}|${q}|${page}`;
  const clearedFor = useRef<string | null>(null);
  const { clear } = selection;
  useEffect(() => {
    if (clearedFor.current === pageKey) {
      return;
    }

    clearedFor.current = pageKey;
    clear();
  }, [pageKey, clear]);

  const ids = threads.map((t) => t.id);
  const chosen = ids.filter((id) => selection.isSelected(id));
  const inJunk = folder === "trash" || folder === "spam";

  /** What a shortcut acts on in the list: the selection, else the row that has the focus. */
  const targets = () => {
    if (chosen.length) {
      return chosen;
    }

    const id = focusedId();

    return id ? [id] : [];
  };

  const act = (action: ThreadAction, idsToUse = targets()) => {
    if (!idsToUse.length) {
      return;
    }

    run(idsToUse, action, { after: () => selection.clear() });
  };

  useShortcuts([
    {
      keys: "x",
      run: () => {
        const id = focusedId();

        if (id) {
          selection.toggle(id);
        }
      },
    },
    { keys: "* a", run: () => selection.set(ids) },
    { keys: "* n", run: () => selection.clear() },
    {
      keys: "* u",
      run: () =>
        selection.set(threads.filter((t) => t.unread).map((t) => t.id)),
    },
    {
      keys: "* r",
      run: () =>
        selection.set(threads.filter((t) => !t.unread).map((t) => t.id)),
    },
    {
      keys: "* s",
      run: () =>
        selection.set(threads.filter((t) => t.starred).map((t) => t.id)),
    },
    { keys: "e", run: () => act({ intent: inJunk ? "inbox" : "archive" }) },
    { keys: "#", run: () => act({ intent: "trash" }) },
    {
      keys: "!",
      run: () => act({ intent: folder === "spam" ? "inbox" : "spam" }),
    },
    {
      keys: "s",
      run: () => {
        const t = targets();

        if (!t.length) {
          return;
        }

        const rows = threads.filter((r) => t.includes(r.id));
        act({ intent: rows.every((r) => r.starred) ? "unstar" : "star" }, t);
      },
    },
    { keys: "I", run: () => act({ intent: "read" }) },
    { keys: "U", run: () => act({ intent: "unread" }) },
    { keys: "m", run: () => act({ intent: "mute" }) },
    { keys: "b", run: () => targets().length && setSnoozeOpen(true) },
    { keys: "l", run: () => targets().length && setLabelOpen(true) },
  ]);

  const onCreateLabel = async (name: string): Promise<LabelRef | null> => {
    const result = await makeLabel({ data: { name } });

    if (!result.ok) {
      toast.show({ message: result.error, tone: "error" });

      return null;
    }

    await router.invalidate();

    return result.label;
  };

  const readAll = async () => {
    const fd = new FormData();
    fd.set("intent", "read-all");
    fd.set("folder", folder);

    if (q) {
      fd.set("q", q);
    }

    if (label) {
      fd.set("label", label.id);
    }

    const r = await folderFn({ data: fd });
    await router.invalidate();
    toast.show({
      message: r.count ? `${r.count} marked as read.` : "Nothing was unread.",
    });
  };

  const empty = async () => {
    if (!inJunk) {
      return;
    }

    if (
      // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
      !confirm(
        `Empty the ${FOLDER_LABEL[folder].toLowerCase()}? Everything in it is deleted forever.`
      )
    ) {
      return;
    }

    const fd = new FormData();
    fd.set("intent", "empty");
    fd.set("folder", folder);
    const show = leaving.hide(ids);

    await withCleanup(async () => {
      const r = await folderFn({ data: fd });
      await router.invalidate({ sync: true });
      toast.show({
        message: `${r.count} ${r.count === 1 ? "conversation" : "conversations"} deleted forever.`,
      });
    }, show);
  };

  /** A click on a row's checkbox: that row, or with Shift the run from the last one picked. */
  const pick = (id: string, on: boolean, range: boolean) => {
    if (range && lastPick.current) {
      const a = ids.indexOf(lastPick.current);
      const b = ids.indexOf(id);

      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];

        for (const rowId of ids.slice(lo, hi + 1)) {
          selection.toggle(rowId, on);
        }

        return;
      }
    }

    selection.toggle(id, on);
    lastPick.current = id;
  };

  return (
    <div className="print-hidden @container flex min-h-0 flex-1 flex-col">
      <ListHeader
        data={data}
        threads={threads}
        total={total}
        chosen={chosen}
        onClear={() => selection.clear()}
        onSelectAll={() => selection.set(ids)}
        labelOpen={labelOpen}
        setLabelOpen={setLabelOpen}
        snoozeOpen={snoozeOpen}
        setSnoozeOpen={setSnoozeOpen}
        onAction={(a) => act(a, chosen)}
        onCreateLabel={onCreateLabel}
        onReadAll={() => {
          readAll();
        }}
        onEmpty={() => {
          empty();
        }}
      />
      {inJunk && threads.length > 0 && (
        <div className="border-line bg-sidebar text-muted flex h-8 shrink-0 items-center border-b px-4 text-sm">
          Conversations in {FOLDER_LABEL[folder].toLowerCase()} for more than 30
          days are deleted.
        </div>
      )}
      <ListBody
        ref={list}
        data={data}
        threads={threads}
        total={total}
        activeId={activeId}
        isSelected={(id) => selection.isSelected(id)}
        onPick={(id, on, range) => pick(id, on, range)}
        onAction={(id, a) => act(a, [id])}
        onOpen={(id) => {
          navigate({
            to: "/mail/t/$threadId",
            params: { threadId: id },
            search: listParams(data),
          });
        }}
      />
    </div>
  );
};
