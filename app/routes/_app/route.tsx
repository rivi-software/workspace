import { withPostHog } from "@rivi-software/posthog-tanstack-start/browser";
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  Archive,
  Bell,
  BellOff,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronsUpDown,
  Clock,
  FileText,
  HardDrive,
  Inbox,
  Keyboard,
  ListTodo,
  LogOut,
  Mail,
  Monitor,
  Moon,
  PanelLeft,
  PenSquare,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Star,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { AssistantSidebar } from "~/components/assistant/sidebar";
import { RiviMark } from "~/components/brand";
import { PlannerSidebar } from "~/components/calendar/sidebar";
import { DriveSidebar } from "~/components/drive/sidebar";
import { UploadPanel, UploadProvider } from "~/components/drive/uploads";
import { leaveField, useShortcuts } from "~/components/keyboard";
import { LabelDot } from "~/components/labels";
import { NewVersionNotice } from "~/components/new-version-notice";
import { ShortcutsHelp } from "~/components/shortcuts-help";
import { syncThemeColor, useTheme } from "~/components/theme";
import type { Theme } from "~/components/theme";
import { ToastProvider, useToast } from "~/components/toast";
import {
  Avatar,
  Menu,
  MenuItem,
  MenuLink,
  MenuSeparator,
  cx,
} from "~/components/ui";
import { listConversations } from "~/lib/assistant/chat.server";
import { colleagues, storageUsed } from "~/lib/drive/drive.server";
import { isJsonObject, stringOrNull } from "~/lib/guards";
import { keepShown } from "~/lib/keep-shown";
import type { Folder, LabelRef } from "~/lib/mail/folders";
import { listLabels } from "~/lib/mail/labels.server";
import { folderCounts, newestUnread } from "~/lib/mail/mailbox.server";
import { parsePreferences } from "~/lib/mail/preferences";
import { participantLabel } from "~/lib/mail/threading";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";
import { githubConnection } from "~/lib/tasks/github.server";

const getLayout = createServerFn().handler(async () => {
  const { db, user, env } = await appContext();

  const [counts, labels, newest, driveUsed, conversations, people, github] =
    await Promise.all([
      folderCounts(db, user.id),
      listLabels(db, user.id),
      newestUnread(db, user.id),
      // What the person's files in Drive take, for the sidebar.
      storageUsed(db, user.id),
      // The person's recent conversations with the Assistant, for its sidebar.
      listConversations(db, user.id, 30),
      // Whom a new event from the sidebar can invite (#3111).
      colleagues(db, user.id),
      // Whether a new task from the sidebar can name a GitHub issue.
      githubConnection(db, user.id),
    ]);

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    counts,
    labels,
    // The newest unread conversation, so a tab can tell of new mail.
    newest: newest
      ? {
          id: newest.id,
          subject: newest.subject,
          people: participantLabel(newest.participants) || "me",
          at: newest.lastMessageAt,
        }
      : null,
    preferences: parsePreferences(user.preferencesJson),
    appName: env.APP_NAME,
    driveUsed,
    conversations,
    colleagues: people,
    githubConnected: github !== null,
  };
});

const folders: FolderItem[] = [
  { folder: "inbox", label: "Inbox", icon: Inbox, key: "g i" },
  { folder: "starred", label: "Starred", icon: Star, key: "g s" },
  { folder: "snoozed", label: "Snoozed", icon: Clock, key: "g b" },
  { folder: "sent", label: "Sent", icon: Send, key: "g t" },
  { folder: "scheduled", label: "Scheduled", icon: CalendarClock },
  { folder: "drafts", label: "Drafts", icon: FileText, key: "g d" },
  { folder: "archive", label: "All mail", icon: Archive, key: "g a" },
  { folder: "spam", label: "Spam", icon: ShieldAlert, key: "g p" },
  { folder: "trash", label: "Trash", icon: Trash2, key: "g x" },
];

const SIDEBAR_KEY = "workspace.sidebar";

const NOTIFY_KEY = "workspace.notify";

/** New mail shows without a reload: the loaders refresh once a minute while the tab is visible, and when it returns. */
const useRefresh = () => {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible" && !router.state.isLoading) {
        router.invalidate();
      }
    };

    const timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);
};

const notificationsOn = (): boolean =>
  typeof Notification !== "undefined" &&
  Notification.permission === "granted" &&
  localStorage.getItem(NOTIFY_KEY) === "on";

/** A desktop notification for mail that arrived after the tab opened, when the person asked for them. */
const useNewMailNotice = (
  newest: { id: string; subject: string; people: string; at: string } | null
) => {
  const navigate = useNavigate();
  const seen = useRef<{ id: string; at: string } | null>(null);
  const since = useRef<string | null>(null);
  useEffect(() => {
    // The tab's opening, which only mail that arrived after it is told of.
    const opened = since.current ?? new Date().toISOString();
    since.current = opened;

    if (!newest) {
      return;
    }

    const prev = seen.current;
    seen.current = { id: newest.id, at: newest.at };

    if (!prev || prev.id === newest.id || newest.at <= opened) {
      return;
    }

    if (!notificationsOn()) {
      return;
    }

    const n = new Notification(newest.people, {
      body: newest.subject,
      tag: `mail-${newest.id}`,
      icon: "/favicon.svg",
    });

    n.addEventListener("click", () => {
      window.focus();
      navigate({
        to: "/mail/t/$threadId",
        params: { threadId: newest.id },
        search: {},
      });
      n.close();
    });
  }, [newest, navigate]);
};

const ThemeItems = ({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
}) => {
  const options: [
    Theme,
    string,
    React.ComponentType<{ className?: string }>,
  ][] = [
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
    ["system", "System", Monitor],
  ];

  return (
    <>
      <div className="text-subtle px-2 pt-1.5 pb-1 text-xs">Theme</div>
      {options.map(([value, label, Icon]) => (
        <MenuItem
          key={value}
          icon={<Icon className="h-3.5 w-3.5" />}
          onClick={() => setTheme(value)}
        >
          <span className="flex items-center justify-between">
            {label}
            {theme === value && <Check className="text-accent h-3.5 w-3.5" />}
          </span>
        </MenuItem>
      ))}
    </>
  );
};

type Layout = Awaited<ReturnType<typeof getLayout>>;

type ShellModule =
  | "mail"
  | "drive"
  | "calendar"
  | "tasks"
  | "assistant"
  | "settings";

const SHELL_MODULES: ShellModule[] = [
  "mail",
  "drive",
  "calendar",
  "tasks",
  "assistant",
  "settings",
];

/** The module a path belongs to; anything else (the mail composer's own paths included) reads as Mail's sidebar. */
const moduleOf = (pathname: string): ShellModule | null =>
  SHELL_MODULES.find((m) => pathname.startsWith(`/${m}`)) ?? null;

// The module strip: five, so each is its icon, named by its tooltip and to a screen reader.
const MODULES: {
  to: "/mail" | "/drive" | "/calendar" | "/tasks" | "/assistant";
  module: ShellModule;
  label: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    to: "/mail",
    module: "mail",
    label: "Mail",
    title: "Mail (g then i)",
    icon: Mail,
  },
  {
    to: "/drive",
    module: "drive",
    label: "Drive",
    title: "Drive (g then f)",
    icon: HardDrive,
  },
  {
    to: "/calendar",
    module: "calendar",
    label: "Calendar",
    title: "Calendar (g then c)",
    icon: CalendarDays,
  },
  {
    to: "/tasks",
    module: "tasks",
    label: "Tasks",
    title: "Tasks (g then k)",
    icon: ListTodo,
  },
  {
    to: "/assistant",
    module: "assistant",
    label: "Assistant",
    title: "Assistant (g then h, or ⌘J)",
    icon: Sparkles,
  },
];

/** A string search param of the address (`folder`, `label`), which the router keeps as the string it is. */
const searchParam = <T extends object>(search: T, key: string): string | null =>
  isJsonObject(search) ? stringOrNull(search[key]) : null;

const isNarrow = () => matchMedia("(max-width: 1023px)").matches;

// The sidebar's and the notifications' settings live in localStorage, which the server cannot read: they are read on
// the client only, as the theme is, and a change made here is announced to the components that show it.
const storedListeners = new Set<() => void>();

const subscribeStored = (listener: () => void) => {
  storedListeners.add(listener);

  return () => {
    storedListeners.delete(listener);
  };
};

const announceStored = () => {
  for (const listener of storedListeners) {
    listener();
  }
};

const sidebarCollapsed = () =>
  localStorage.getItem(SIDEBAR_KEY) === "collapsed";

const toggleCollapsed = () => {
  localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed() ? "open" : "collapsed");
  announceStored();
};

const keepNotifying = (on: boolean) => {
  localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
  announceStored();
};

const neverStored = () => false;

/** The sidebar: collapsed on a wide screen, a drawer on a narrow one that closes when the page changes. */
const useSidebar = (pathname: string) => {
  const collapsed = useSyncExternalStore(
    subscribeStored,
    sidebarCollapsed,
    neverStored
  );

  const [drawer, setDrawer] = useState(false);
  const [drawerPath, setDrawerPath] = useState(pathname);

  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    setDrawer(false);
  }

  const toggle = () => {
    if (isNarrow()) {
      setDrawer((d) => !d);

      return;
    }

    toggleCollapsed();
  };

  return { collapsed, drawer, closeDrawer: () => setDrawer(false), toggle };
};

/** Whether new mail is announced by a desktop notification, and the switch that asks the browser for them. */
const useNotifications = () => {
  const toast = useToast();

  const notify = useSyncExternalStore(
    subscribeStored,
    notificationsOn,
    neverStored
  );

  const toggle = async () => {
    if (notify) {
      keepNotifying(false);

      return;
    }

    if (typeof Notification === "undefined") {
      toast.show({
        message: "This browser has no notifications.",
        tone: "error",
      });

      return;
    }

    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      toast.show({ message: "Notifications were not allowed in the browser." });

      return;
    }

    keepNotifying(true);
    toast.show({
      message: "You will be told of new mail while this tab is open.",
    });
  };

  return { notify, toggle };
};

const useShellShortcuts = ({
  toggleSidebar,
  showHelp,
}: {
  toggleSidebar: () => void;
  showHelp: () => void;
}) => {
  const navigate = useNavigate();
  const toast = useToast();

  useShortcuts([
    { keys: "mod+b", run: toggleSidebar, allowInInput: true },
    { keys: "Escape", run: leaveField, allowInInput: true },
    {
      keys: "c",
      run: () => {
        navigate({ to: "/mail/compose", search: {} });
      },
    },
    {
      keys: "/",
      run: () =>
        document.querySelector<HTMLInputElement>("input[name=q]")?.focus(),
    },
    { keys: "?", run: showHelp },
    { keys: "z", run: () => toast.undo() },
    ...folders.flatMap((f) =>
      f.key
        ? [
            {
              keys: f.key,
              run: () => {
                navigate({
                  to: "/mail",
                  search: f.folder === "inbox" ? {} : { folder: f.folder },
                });
              },
            },
          ]
        : []
    ),
    {
      keys: "g ,",
      run: () => {
        navigate({ to: "/settings", search: {} });
      },
    },
    {
      keys: "g f",
      run: () => {
        navigate({ to: "/drive", search: {} });
      },
    },
    {
      keys: "g c",
      run: () => {
        navigate({ to: "/calendar", search: {} });
      },
    },
    {
      keys: "g k",
      run: () => {
        navigate({ to: "/tasks", search: {} });
      },
    },
    {
      keys: "g h",
      run: () => {
        navigate({ to: "/assistant", search: {} });
      },
    },
    {
      keys: "mod+j",
      run: () => {
        navigate({ to: "/assistant", search: {} });
      },
      allowInInput: true,
    },
  ]);
};

const AccountMenu = ({
  user,
  appName,
  theme,
  setTheme,
  notify,
  onToggleNotify,
  onShowHelp,
}: {
  user: Layout["user"];
  appName: string;
  theme: Theme;
  setTheme: (t: Theme) => void;
  notify: boolean;
  onToggleNotify: () => Promise<void>;
  onShowHelp: () => void;
}) => (
  <Menu
    className="min-w-0 flex-1"
    align="start"
    label="Account"
    menuClassName="w-60"
    renderTrigger={({ toggle, open }) => (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cx(
          "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-base font-medium transition-colors duration-100 hover:bg-hover",
          open && "bg-hover"
        )}
      >
        <RiviMark className="shrink-0 text-[20px]" />
        <span className="truncate">{appName}</span>
        <ChevronsUpDown className="text-subtle ml-auto h-3.5 w-3.5 shrink-0" />
      </button>
    )}
  >
    <div className="text-subtle truncate px-2 py-1.5 text-xs">{user.email}</div>
    <MenuSeparator />
    <ThemeItems theme={theme} setTheme={setTheme} />
    <MenuSeparator />
    {/* A web view has no notifications of its own (Workspace for iPhone and Android, #3529): the switch would only say so. */}
    {typeof Notification !== "undefined" && (
      <MenuItem
        icon={
          notify ? (
            <Bell className="h-3.5 w-3.5" />
          ) : (
            <BellOff className="h-3.5 w-3.5" />
          )
        }
        onClick={() => {
          onToggleNotify();
        }}
      >
        <span className="flex items-center justify-between">
          New mail notifications
          {notify && <Check className="text-accent h-3.5 w-3.5" />}
        </span>
      </MenuItem>
    )}
    <MenuItem icon={<Keyboard className="h-3.5 w-3.5" />} onClick={onShowHelp}>
      Keyboard shortcuts
    </MenuItem>
    <MenuLink
      icon={<Settings className="h-3.5 w-3.5" />}
      to="/settings"
      search={{}}
    >
      Settings
    </MenuLink>
    <MenuSeparator />
    <form
      method="post"
      action="/logout"
      onSubmit={() => withPostHog((posthog) => posthog.reset())}
    >
      <MenuItem type="submit" icon={<LogOut className="h-3.5 w-3.5" />}>
        Sign out
      </MenuItem>
    </form>
  </Menu>
);

// On a phone the tab bar at the bottom of the screen takes its place (`TabBar`).
const ModuleStrip = ({ current }: { current: ShellModule | null }) => (
  <nav
    className="bg-hover mx-3 mb-3 grid grid-cols-5 gap-0.5 rounded-md p-0.5 max-sm:hidden"
    aria-label="Modules"
  >
    {MODULES.map((m) => (
      <Link
        key={m.to}
        to={m.to}
        search={{}}
        className={cx(
          "flex h-6 items-center justify-center rounded-[5px] transition-colors duration-100",
          m.module === current
            ? "bg-elevated text-fg shadow-[0_1px_1px_rgb(0_0_0/0.06)]"
            : "text-muted hover:text-fg"
        )}
        aria-current={m.module === current ? "page" : undefined}
        aria-label={m.label}
        title={m.title}
      >
        <m.icon className="h-4 w-4" />
      </Link>
    ))}
  </nav>
);

/**
 * On a phone, the modules as a tab bar at the bottom of the screen, where a thumb reaches them
 * (#3529): one tap switches modules, and the drawer keeps the module's own navigation. It sits
 * above the home indicator (`pb-safe`) and steps aside while the person types (app.css, `--dock`).
 */
const TabBar = ({ current }: { current: ShellModule | null }) => (
  <nav
    data-tab-bar
    aria-label="Modules"
    className="border-line bg-sidebar/95 px-safe pb-safe print-hidden fixed inset-x-0 bottom-0 z-20 border-t backdrop-blur-sm sm:hidden"
  >
    <ul className="grid h-12 grid-cols-5">
      {MODULES.map((m) => (
        <li key={m.to} className="min-w-0">
          <Link
            to={m.to}
            search={{}}
            className={cx(
              "flex h-12 flex-col items-center justify-center gap-0.5 text-2xs font-medium transition-colors duration-100",
              m.module === current ? "text-accent" : "text-muted"
            )}
            aria-current={m.module === current ? "page" : undefined}
          >
            <m.icon className="h-5 w-5" />
            <span className="max-w-full truncate">{m.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  </nav>
);

const MailSidebar = ({
  onMail,
  folder: searchedFolder,
  label: searchedLabel,
  counts,
  labels,
}: {
  onMail: boolean;
  folder: string | null;
  label: string | null;
  counts: Layout["counts"];
  labels: Layout["labels"];
}) => {
  const activeFolder = searchedLabel ? null : (searchedFolder ?? "inbox");

  const badges: Partial<Record<Folder, number>> = {
    inbox: counts.inboxUnread,
    drafts: counts.drafts,
    scheduled: counts.scheduled,
    snoozed: counts.snoozed,
    spam: counts.spamUnread,
  };

  const badgeWord: Partial<Record<Folder, string>> = {
    inbox: "unread",
    drafts: "drafts",
    scheduled: "scheduled",
    snoozed: "snoozed",
    spam: "unread",
  };

  return (
    <>
      <div className="px-3 pb-3">
        <Link
          to="/mail/compose"
          search={{}}
          className="bg-accent text-accent-fg hover:bg-accent-hover flex h-7 w-full items-center justify-center gap-1.5 rounded-md px-2.5 text-base font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_1px_rgb(0_0_0/0.08)] transition-colors"
          title="Compose (c)"
        >
          <PenSquare className="h-3.5 w-3.5" />
          Compose
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Mail">
        <div className="text-subtle mb-1 px-2 text-xs font-medium">Mail</div>
        <ul className="space-y-px">
          {folders.map(({ folder, label, icon: Icon }) => {
            const active = onMail && activeFolder === folder;
            const badge = badges[folder] ?? 0;

            return (
              <li key={folder}>
                <Link
                  to="/mail"
                  search={folder === "inbox" ? {} : { folder }}
                  className={cx(
                    "flex h-7 items-center gap-2 rounded-md px-2 text-base transition-colors duration-100",
                    active
                      ? "bg-active text-fg"
                      : "text-muted hover:bg-hover hover:text-fg"
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{label}</span>
                  {badge > 0 && (
                    <span
                      className={cx(
                        "tnum rounded-[4px] px-1.5 text-2xs font-semibold",
                        folder === "inbox"
                          ? "bg-accent-soft text-accent"
                          : "bg-hover text-muted"
                      )}
                      aria-label={`${badge} ${badgeWord[folder]}`}
                    >
                      {badge}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="text-subtle mt-4 mb-1 flex items-center px-2 text-xs font-medium">
          <span className="flex-1">Labels</span>
          <Link
            to="/settings"
            search={{ tab: "mail" }}
            className="hover:bg-hover hover:text-fg -mr-1 flex h-5 w-5 items-center justify-center rounded-md"
            aria-label="Manage labels"
            title="Manage labels"
          >
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </div>
        <ul className="space-y-px">
          {labels.map((l: LabelRef) => {
            const active = onMail && searchedLabel === l.id;
            const unread = counts.labels[l.id] ?? 0;

            return (
              <li key={l.id}>
                <Link
                  to="/mail"
                  search={{ label: l.id }}
                  className={cx(
                    "flex h-7 items-center gap-2 rounded-md px-2 text-base transition-colors duration-100",
                    active
                      ? "bg-active text-fg"
                      : "text-muted hover:bg-hover hover:text-fg"
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    <LabelDot color={l.color} />
                  </span>
                  <span className="flex-1 truncate">{l.name}</span>
                  {unread > 0 && (
                    <span
                      className="tnum text-2xs text-subtle font-semibold"
                      aria-label={`${unread} unread`}
                    >
                      {unread}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
          {!labels.length && (
            <li className="text-subtle px-2 py-1 text-xs">
              None yet.{" "}
              <Link
                to="/settings"
                search={{ tab: "mail" }}
                className="underline-offset-2 hover:underline"
              >
                Add one
              </Link>
            </li>
          )}
        </ul>
      </nav>
    </>
  );
};

const ModuleSidebar = ({
  layout,
  current,
  pathname,
  folder,
  label,
}: {
  layout: Layout;
  current: ShellModule | null;
  pathname: string;
  folder: string | null;
  label: string | null;
}) => {
  if (current === "drive") {
    return <DriveSidebar used={layout.driveUsed} />;
  }

  if (current === "assistant") {
    const activeId =
      pathname.match(/^\/assistant\/c\/(?<id>[^/]+)/u)?.[1] ?? null;

    return (
      <AssistantSidebar
        conversations={layout.conversations}
        activeId={activeId}
      />
    );
  }

  if (current === "calendar" || current === "tasks") {
    return (
      <PlannerSidebar
        module={current}
        colleagues={layout.colleagues}
        githubConnected={layout.githubConnected}
      />
    );
  }

  return (
    <MailSidebar
      onMail={current === "mail"}
      folder={folder}
      label={label}
      counts={layout.counts}
      labels={layout.labels}
    />
  );
};

const SidebarFooter = ({
  name,
  onSettings,
  theme,
  setTheme,
  onShowHelp,
}: {
  name: string;
  onSettings: boolean;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onShowHelp: () => void;
}) => (
  <div className="border-line flex h-11 items-center gap-2 border-t px-3">
    <Avatar name={name} size={20} />
    <div className="text-muted min-w-0 flex-1 truncate text-sm">{name}</div>
    <Link
      to="/settings"
      search={{}}
      className={cx(
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-fg",
        onSettings ? "bg-active text-fg" : "text-subtle"
      )}
      aria-label="Settings"
      aria-current={onSettings ? "page" : undefined}
      title="Settings (g then ,)"
    >
      <Settings className="h-3.5 w-3.5" />
    </Link>
    <button
      type="button"
      onClick={onShowHelp}
      className="text-subtle hover:bg-hover hover:text-fg flex h-6 w-6 items-center justify-center rounded-md transition-colors"
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts (?)"
    >
      <Keyboard className="h-3.5 w-3.5" />
    </button>
    <button
      type="button"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="text-subtle hover:bg-hover hover:text-fg flex h-6 w-6 items-center justify-center rounded-md transition-colors"
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      <Sun className="hidden h-3.5 w-3.5 dark:block" />
      <Moon className="h-3.5 w-3.5 dark:hidden" />
    </button>
  </div>
);

const AppShell = () => {
  useRefresh();

  const layout = Route.useLoaderData();
  const { user, newest, appName } = layout;
  const loading = useRouterState({ select: (s) => s.isLoading });
  const { pathname, search } = useLocation();
  const [theme, setTheme] = useTheme();
  const [help, setHelp] = useState(false);

  // The browser's chrome and a phone's status bar in the chosen theme's canvas, which the page's
  // own metas only know by the system's reading (routes/__root.tsx).
  useEffect(() => {
    syncThemeColor(theme);
  }, [theme]);

  const {
    collapsed,
    drawer,
    closeDrawer,
    toggle: toggleSidebar,
  } = useSidebar(pathname);

  const { notify, toggle: toggleNotify } = useNotifications();
  useNewMailNotice(newest);
  useShellShortcuts({ toggleSidebar, showHelp: () => setHelp(true) });

  // People are PostHog persons by their user id, so an error shows who it happened to.
  useEffect(() => {
    withPostHog((posthog) =>
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
        role: user.role,
      })
    );
  }, [user.id, user.email, user.name, user.role]);

  const current = moduleOf(pathname);

  return (
    <div className="bg-bg text-fg flex h-dvh overflow-hidden print:h-auto print:overflow-visible">
      <div
        aria-hidden
        className={cx(
          "pointer-events-none fixed inset-x-0 top-[var(--safe-top)] z-[60] h-0.5 origin-left bg-accent transition-[transform,opacity] duration-180 ease-out",
          loading
            ? "scale-x-[0.7] opacity-100 delay-150"
            : "scale-x-100 opacity-0"
        )}
      />

      {drawer && (
        <button
          type="button"
          className="animate-fade-in fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px] lg:hidden"
          aria-label="Close menu"
          onClick={closeDrawer}
        />
      )}
      <aside
        className={cx(
          "flex w-[232px] shrink-0 flex-col border-r border-line bg-sidebar pt-safe pb-safe transition-[width,opacity,transform] duration-180 ease-out print-hidden",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40",
          // The shadow only while open: closed off-screen, its blur still darkens the page's left edge.
          drawer
            ? "max-lg:translate-x-0 max-lg:shadow-dialog"
            : "max-lg:-translate-x-full",
          collapsed ? "lg:w-0 lg:overflow-hidden lg:opacity-0" : "lg:w-[232px]"
        )}
        aria-hidden={collapsed || undefined}
      >
        <div className="flex h-12 items-center gap-1 px-3">
          <AccountMenu
            user={user}
            appName={appName}
            theme={theme}
            setTheme={setTheme}
            notify={notify}
            onToggleNotify={toggleNotify}
            onShowHelp={() => setHelp(true)}
          />
          <button
            type="button"
            onClick={toggleSidebar}
            className="text-subtle hover:bg-hover hover:text-fg flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (⌘B)"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>

        <ModuleStrip current={current} />

        <ModuleSidebar
          layout={layout}
          current={current}
          pathname={pathname}
          folder={searchParam(search, "folder")}
          label={searchParam(search, "label")}
        />

        <SidebarFooter
          name={user.name}
          onSettings={current === "settings"}
          theme={theme}
          setTheme={setTheme}
          onShowHelp={() => setHelp(true)}
        />
      </aside>

      <main
        className="group/main pt-safe pb-dock relative flex min-w-0 flex-1 flex-col overflow-hidden print:overflow-visible"
        data-collapsed={collapsed || undefined}
      >
        <button
          type="button"
          onClick={toggleSidebar}
          className={cx(
            "absolute left-2 top-[calc(0.375rem+var(--safe-top))] z-10 flex h-7 w-7 items-center justify-center rounded-md border border-line bg-elevated text-subtle shadow-pop transition-colors hover:text-fg animate-fade-in print-hidden",
            collapsed ? "" : "lg:hidden"
          )}
          aria-label="Open sidebar"
          title="Open sidebar (⌘B)"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <Outlet />
      </main>
      <TabBar current={current} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
      <UploadPanel />
      <NewVersionNotice />
    </div>
  );
};

const AppLayout = () => (
  <ToastProvider>
    <UploadProvider>
      <AppShell />
    </UploadProvider>
  </ToastProvider>
);

export const Route = createFileRoute("/_app")({
  // The sidebar's counts and lists stay when the minute's refresh cannot reach the Worker (#3547).
  loader: (run) => keepShown(run, () => getLayout({ fetch: serverFnFetch })),
  component: AppLayout,
});

interface FolderItem {
  folder: Folder;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** The `g` shortcut that opens it, when it has one. */
  key?: string;
}
