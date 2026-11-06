import {
  Link,
  createFileRoute,
  notFound,
  useHydrated,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BellOff,
  Bell,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  Forward,
  MailOpen,
  MoreHorizontal,
  Printer,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  UnfoldVertical,
  FoldVertical,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Composer } from "~/components/composer";
import { useShortcuts } from "~/components/keyboard";
import {
  LabelChip,
  LabelPicker,
  LabelTriggerButton,
} from "~/components/labels";
import { listParams } from "~/components/mail-list";
import { useSelection } from "~/components/mail-selection";
import { MessageCard } from "~/components/message-card";
import type { MessageData, SenderRuleView } from "~/components/message-card";
import { SnoozeMenu, SnoozeTriggerButton } from "~/components/snooze-menu";
import { useToast } from "~/components/toast";
import {
  Button,
  IconButton,
  Menu,
  MenuAnchor,
  MenuItem,
  MenuLink,
  MenuSeparator,
  Notice,
  ViewHeader,
  cx,
} from "~/components/ui";
import { useThreadActions } from "~/components/use-thread-actions";
import { defined } from "~/lib/guards";
import { keepShown } from "~/lib/keep-shown";
import {
  composePrefill,
  quickLabel,
  senderAction,
  unsubscribeAction,
} from "~/lib/mail/actions";
import { composeData } from "~/lib/mail/compose.server";
import type { ComposeData } from "~/lib/mail/compose.server";
import type { LabelRef } from "~/lib/mail/folders";
import { listImageSenders, loadsImages } from "~/lib/mail/images.server";
import { loadThread } from "~/lib/mail/mailbox.server";
import { sanitizeHtml } from "~/lib/mail/sanitize";
import { draftForThread } from "~/lib/mail/send.server";
import { snoozeLabel } from "~/lib/mail/snooze";
import { senderRuleFor } from "~/lib/mail/spam";
import { listSenderRules } from "~/lib/mail/spam.server";
import { isForwardSubject } from "~/lib/mail/threading";
import { markThreadRead } from "~/lib/mail/threads.server";
import type { ThreadAction } from "~/lib/mail/views";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { Route as MailRoute, inboxUnreadOf, listOf, mailTitle } from "./mail";

const getThread = createServerFn()
  .validator((d: { threadId: string }) => d)
  .handler(async ({ data }) => {
    const { db, env, user, request } = await appContext();
    const loaded = await loadThread(db, env, user.id, data.threadId);

    if (!loaded) {
      throw notFound();
    }

    const { thread, messages, labels } = loaded;
    // Opening a conversation reads it, as in every mail client.
    const wasUnread = thread.unreadCount > 0;

    if (wasUnread) {
      await markThreadRead(db, user.id, thread.id);
    }

    // Whether the owner blocked or allowed each sender, for the messages' menus, and whose images they always load.
    const [rules, imageSenders] = await Promise.all([
      listSenderRules(db, user.id),
      listImageSenders(db, user.id),
    ]);

    const senderRules: Record<string, SenderRuleView | null> = {};

    for (const m of messages) {
      if (m.direction === "inbound" && !(m.from.email in senderRules)) {
        const rule = senderRuleFor(rules, m.from.email);
        senderRules[m.from.email] = rule
          ? { sender: rule.sender, verdict: rule.verdict }
          : null;
      }
    }

    // A reply or forward begun here and not sent opens again in the reply box.
    const draft = await draftForThread(db, user.id, thread.id);

    const draftCompose = draft
      ? await composeData(db, user, { draft: draft.id })
      : null;

    const { origin } = new URL(request.url);

    return {
      origin,
      wasUnread,
      draftCompose,
      senderRules,
      thread: {
        id: thread.id,
        subject: thread.subject,
        folder: thread.folder,
        starred: thread.starred,
        muted: thread.muted,
        snoozedUntil: thread.snoozedUntil,
        messageCount: thread.messageCount,
        labels,
      },
      messages: messages.map((m): MessageData => {
        const inline = new Map(
          m.attachments
            .filter((a) => a.contentId)
            .map(
              (a) => [defined(a.contentId, "the content id"), a.url] as const
            )
        );

        const safe = m.html
          ? sanitizeHtml(m.html, {
              cidUrl: (cid) => inline.get(cid) ?? null,
              forward: isForwardSubject(m.subject),
            })
          : null;

        return {
          ...m,
          html: safe?.html ?? null,
          remoteImages: safe?.remoteImages ?? false,
          loadImages:
            m.direction === "inbound" &&
            loadsImages(imageSenders, m.from.email, thread.folder),
          files: m.attachments.filter((a) => !a.inline || !a.contentId),
        };
      }),
    };
  });

const NeighbourLink = ({
  thread,
  search,
  label,
  children,
}: {
  thread: { id: string } | null;
  search: ReturnType<typeof listParams>;
  label: string;
  children: React.ReactNode;
}) => {
  if (!thread) {
    return (
      <span
        aria-disabled
        className="text-faint hidden h-7 w-7 items-center justify-center rounded-md sm:inline-flex"
      >
        {children}
      </span>
    );
  }

  return (
    <Link
      to="/mail/t/$threadId"
      params={{ threadId: thread.id }}
      search={search}
      aria-label={label}
      title={label}
      className="text-muted hover:bg-hover hover:text-fg hidden h-7 w-7 items-center justify-center rounded-md sm:inline-flex"
    >
      {children}
    </Link>
  );
};

type Loaded = Awaited<ReturnType<typeof getThread>>;

type ThreadInfo = Loaded["thread"];

type ComposeMode = "reply" | "all" | "forward";

/** An action on the open conversation; one that leaves it goes back to the list first. */
type Act = (action: ThreadAction, leave?: boolean) => Promise<void>;

const isJunk = (folder: ThreadInfo["folder"]): boolean =>
  folder === "trash" || folder === "spam";

/** Which messages are open in the conversation, and which is being printed. */
const useReading = (messages: MessageData[], last: MessageData | undefined) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        messages.flatMap((m, i) =>
          i === messages.length - 1 || !m.read ? [m.id] : []
        )
      )
  );

  const [printing, setPrinting] = useState<string | "all" | null>(null);

  // A message that arrives or is sent while the conversation is open shows itself.
  const [seenLast, setSeenLast] = useState(last);

  if (seenLast !== last) {
    setSeenLast(last);

    if (last) {
      setOpen((o) => (o.has(last.id) ? o : new Set([...o, last.id])));
    }
  }

  const allOpen = open.size === messages.length;

  const toggleAll = () => {
    setOpen(
      allOpen
        ? new Set(last ? [last.id] : [])
        : new Set(messages.map((m) => m.id))
    );
  };

  const toggle = (id: string) => {
    setOpen((o) => {
      const n = new Set(o);

      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
      }

      return n;
    });
  };

  const print = (what: string | "all") => {
    setPrinting(what);

    if (what === "all") {
      setOpen(new Set(messages.map((m) => m.id)));
    } else {
      setOpen((o) => new Set([...o, what]));
    }

    setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 150);
  };

  return { open, allOpen, printing, toggle, toggleAll, print };
};

type Reading = ReturnType<typeof useReading>;

/** The reply box: the composer once a reply, reply all or forward is begun (or a draft of one was kept). */
const useReplyBox = (
  draftCompose: ComposeData | null,
  last: MessageData | undefined
) => {
  const prefill = useServerFn(composePrefill);
  const [compose, setCompose] = useState<ComposeData | null>(draftCompose);
  const replyBox = useRef<HTMLDivElement>(null);

  const composeWith = async (mode: ComposeMode, messageId?: string) => {
    const target = messageId ?? last?.id;

    if (!target) {
      return;
    }

    const data = await prefill({ data: { reply: target, mode } });

    if (!data) {
      return;
    }

    setCompose(data);
    requestAnimationFrame(() =>
      replyBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    );
  };

  return { compose, setCompose, replyBox, composeWith };
};

/** What the owner does with a message's sender: unsubscribe, block, or always load their images. */
const useSenderActions = (threadId: string, back: () => void) => {
  const router = useRouter();
  const toast = useToast();
  const unsubscribe = useServerFn(unsubscribeAction);
  const senders = useServerFn(senderAction);

  const onUnsubscribe = async (m: MessageData) => {
    const ways = m.unsubscribe;

    if (!ways) {
      return;
    }

    // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
    if (!confirm(`Unsubscribe from mail like this from ${m.from.email}?`)) {
      return;
    }

    if (ways.oneClick || (ways.mailto && !ways.http)) {
      const fd = new FormData();
      fd.set("messageId", m.id);
      const result = await unsubscribe({ data: fd });
      toast.show({
        message: result.ok ? result.message : result.error,
        tone: result.ok ? "neutral" : "error",
      });

      if (result.ok || !ways.http) {
        return;
      }
    }

    if (ways.http) {
      window.open(ways.http, "_blank", "noopener,noreferrer");
    }
  };

  const onSender = async (
    intent: "block" | "unblock" | "images",
    sender: string
  ) => {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("sender", sender);
    fd.set("threadId", threadId);
    const result = await senders({ data: fd });
    toast.show({
      message: result.ok ? result.message : result.error,
      tone: result.ok ? "neutral" : "error",
    });
    // The list reloads first: going back alone keeps the list as it was, the moved conversation in it.
    await router.invalidate();

    if (result.ok && result.moved) {
      back();
    }
  };

  const onBlock = (m: MessageData) => {
    if (
      // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
      confirm(`Block ${m.from.email}? Their mail goes to Spam from now on.`)
    ) {
      onSender("block", m.from.email);
    }
  };

  return { onUnsubscribe, onSender, onBlock };
};

type Sender = ReturnType<typeof useSenderActions>;

/** Makes a label from the picker's search box; the list reloads to carry it. */
const useCreateLabel = () => {
  const router = useRouter();
  const toast = useToast();
  const makeLabel = useServerFn(quickLabel);

  const create = async (name: string): Promise<LabelRef | null> => {
    const result = await makeLabel({ data: { name } });

    if (!result.ok) {
      toast.show({ message: result.error, tone: "error" });

      return null;
    }

    await router.invalidate();

    return result.label;
  };

  return create;
};

interface ShortcutControls {
  act: Act;
  back: () => void;
  composeWith: (mode: ComposeMode) => void;
  toggleAll: () => void;
  openSnooze: () => void;
  openLabels: () => void;
}

/** The list's shortcuts act on its selection; these on the open conversation, when nothing is selected. */
const useThreadShortcuts = (
  thread: ThreadInfo,
  {
    act,
    back,
    composeWith,
    toggleAll,
    openSnooze,
    openLabels,
  }: ShortcutControls
) => {
  const selection = useSelection();

  const own = (run: () => void) => () => {
    if (selection.selected.size === 0) {
      run();
    }
  };

  useShortcuts([
    { keys: "u", run: own(back) },
    {
      keys: "e",
      run: own(() => {
        act({ intent: isJunk(thread.folder) ? "inbox" : "archive" }, true);
      }),
    },
    {
      keys: "#",
      run: own(() => {
        act({ intent: "trash" }, true);
      }),
    },
    {
      keys: "!",
      run: own(() => {
        act({ intent: thread.folder === "spam" ? "inbox" : "spam" }, true);
      }),
    },
    {
      keys: "s",
      run: own(() => {
        act({ intent: thread.starred ? "unstar" : "star" });
      }),
    },
    {
      keys: "m",
      run: own(() => {
        act({ intent: thread.muted ? "unmute" : "mute" }, !thread.muted);
      }),
    },
    {
      keys: "I",
      run: own(() => {
        act({ intent: "read" });
      }),
    },
    {
      keys: "U",
      run: own(() => {
        act({ intent: "unread" }, true);
      }),
    },
    { keys: "b", run: own(openSnooze) },
    { keys: "l", run: own(openLabels) },
    {
      keys: "r",
      run: own(() => {
        composeWith("reply");
      }),
    },
    {
      keys: "a",
      run: own(() => {
        composeWith("all");
      }),
    },
    {
      keys: "f",
      run: own(() => {
        composeWith("forward");
      }),
    },
    { keys: ";", run: own(toggleAll) },
  ]);
};

/** Why the conversation is in Spam, when the spam filter put it there: the newest message it held back says, or
 * the newest that went for a reason of its own rather than for joining a conversation already there. */
const spamReason = (messages: MessageData[]) => {
  const held = messages.toReversed().filter((m) => m.spam);

  return (
    (
      held.find((m) => defined(m.spam, "the spam").by !== "conversation") ??
      held[0]
    )?.spam ?? null
  );
};

/** Archive, spam and trash. On a phone the subject needs the room: spam and trash move into the More menu. */
const MoveButtons = ({
  folder,
  act,
}: {
  folder: ThreadInfo["folder"];
  act: Act;
}) => (
  <>
    {isJunk(folder) ? (
      <IconButton
        label="Move to inbox (e)"
        onClick={() => {
          act({ intent: "inbox" }, true);
        }}
      >
        <ArchiveRestore className="h-4 w-4" />
      </IconButton>
    ) : (
      <IconButton
        label="Archive (e)"
        onClick={() => {
          act({ intent: "archive" }, true);
        }}
      >
        <Archive className="h-4 w-4" />
      </IconButton>
    )}
    {folder === "spam" ? (
      <IconButton
        label="Not spam (!)"
        onClick={() => {
          act({ intent: "inbox" }, true);
        }}
        className="max-sm:hidden"
      >
        <ShieldCheck className="h-4 w-4" />
      </IconButton>
    ) : (
      <IconButton
        label="Mark as spam (!)"
        onClick={() => {
          act({ intent: "spam" }, true);
        }}
        className="max-sm:hidden"
      >
        <ShieldAlert className="h-4 w-4" />
      </IconButton>
    )}
    {folder !== "trash" && (
      <IconButton
        label="Move to trash (#)"
        onClick={() => {
          act({ intent: "trash" }, true);
        }}
        className="max-sm:hidden"
      >
        <Trash2 className="h-4 w-4" />
      </IconButton>
    )}
  </>
);

const StarButton = ({ starred, act }: { starred: boolean; act: Act }) => (
  <IconButton
    label={starred ? "Unstar (s)" : "Star (s)"}
    onClick={() => {
      act({ intent: starred ? "unstar" : "star" });
    }}
    className={cx("max-sm:hidden", starred && "text-star hover:text-star")}
  >
    <Star className="h-4 w-4" fill={starred ? "currentColor" : "none"} />
  </IconButton>
);

/** What the More menu adds on a phone, where the header has no room for the star, spam and trash buttons. */
const PhoneMenuItems = ({ thread, act }: { thread: ThreadInfo; act: Act }) => (
  <>
    <MenuItem
      icon={<Star className="h-3.5 w-3.5" />}
      onClick={() => {
        act({ intent: thread.starred ? "unstar" : "star" });
      }}
      className="sm:hidden"
    >
      {thread.starred ? "Unstar" : "Star"}
    </MenuItem>
    {thread.folder === "spam" ? (
      <MenuItem
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
        onClick={() => {
          act({ intent: "inbox" }, true);
        }}
        className="sm:hidden"
      >
        Not spam
      </MenuItem>
    ) : (
      <MenuItem
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        onClick={() => {
          act({ intent: "spam" }, true);
        }}
        className="sm:hidden"
      >
        Mark as spam
      </MenuItem>
    )}
    {thread.folder !== "trash" && (
      <MenuItem
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={() => {
          act({ intent: "trash" }, true);
        }}
        className="sm:hidden"
      >
        Move to trash
      </MenuItem>
    )}
    <MenuSeparator className="sm:hidden" />
  </>
);

const StateMenuItems = ({ thread, act }: { thread: ThreadInfo; act: Act }) => (
  <>
    <MenuItem
      icon={<MailOpen className="h-3.5 w-3.5" />}
      onClick={() => {
        act({ intent: "unread" }, true);
      }}
    >
      Mark as unread
    </MenuItem>
    <MenuItem
      icon={
        thread.muted ? (
          <Bell className="h-3.5 w-3.5" />
        ) : (
          <BellOff className="h-3.5 w-3.5" />
        )
      }
      onClick={() => {
        act({ intent: thread.muted ? "unmute" : "mute" }, !thread.muted);
      }}
    >
      {thread.muted ? "Unmute" : "Mute"}
    </MenuItem>
    {thread.snoozedUntil && (
      <MenuItem
        icon={<Clock className="h-3.5 w-3.5" />}
        onClick={() => {
          act({ intent: "unsnooze" });
        }}
      >
        Unsnooze
      </MenuItem>
    )}
  </>
);

const ThreadMenu = ({
  thread,
  messages,
  reading,
  act,
}: {
  thread: ThreadInfo;
  messages: MessageData[];
  reading: Reading;
  act: Act;
}) => {
  const last = messages.at(-1);
  const { allOpen, toggleAll, print } = reading;

  return (
    <Menu
      label="More"
      renderTrigger={({ toggle, open: o }) => (
        <IconButton
          label="More"
          onClick={toggle}
          active={o}
          aria-haspopup="menu"
          aria-expanded={o}
        >
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
      )}
    >
      <PhoneMenuItems thread={thread} act={act} />
      <StateMenuItems thread={thread} act={act} />
      {messages.length > 1 && (
        <MenuItem
          icon={
            allOpen ? (
              <FoldVertical className="h-3.5 w-3.5" />
            ) : (
              <UnfoldVertical className="h-3.5 w-3.5" />
            )
          }
          onClick={toggleAll}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </MenuItem>
      )}
      <MenuItem
        icon={<Printer className="h-3.5 w-3.5" />}
        onClick={() => print("all")}
      >
        Print
      </MenuItem>
      <MenuLink
        icon={<Sparkles className="h-3.5 w-3.5" />}
        to="/assistant"
        search={{
          prompt: `Summarize the conversation “${thread.subject}” (${thread.id}).`,
        }}
      >
        Ask the assistant
      </MenuLink>
      {last?.hasRaw && (
        <MenuAnchor
          icon={<Download className="h-3.5 w-3.5" />}
          href={`/api/messages/${last.id}/raw`}
        >
          Download original
        </MenuAnchor>
      )}
      {isJunk(thread.folder) && (
        <>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => {
              if (
                // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                confirm(
                  "Delete this conversation forever? Its messages and files cannot be recovered."
                )
              ) {
                act({ intent: "delete" }, true);
              }
            }}
          >
            Delete forever
          </MenuItem>
        </>
      )}
    </Menu>
  );
};

/** The snooze picker; `forced` holds it open, as the `b` shortcut does. */
const SnoozePicker = ({
  forced,
  onForcedChange,
  act,
}: {
  forced: boolean;
  onForcedChange: (open: boolean) => void;
  act: Act;
}) => (
  <SnoozeMenu
    onPick={(until) => {
      act({ intent: "snooze", until }, true);
    }}
    renderTrigger={({ open: o, toggle }) => (
      <SnoozeTriggerButton
        open={o || forced}
        toggle={() => {
          onForcedChange(false);
          toggle();
        }}
      />
    )}
  />
);

/** The label picker for the conversation; `forced` opens it, as the `l` shortcut does. */
const ThreadLabelPicker = ({
  labels,
  applied,
  forced,
  onForcedChange,
  onCreate,
  act,
}: {
  labels: LabelRef[];
  applied: ThreadInfo["labels"];
  forced: boolean;
  onForcedChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<LabelRef | null>;
  act: Act;
}) => {
  const state = new Map<string, "all" | "some">(
    applied.map((l) => [l.id, "all"])
  );

  return (
    <LabelPicker
      labels={labels}
      state={state}
      onToggle={(l, on) => {
        act({ intent: on ? "label" : "unlabel", labelId: l.id });
      }}
      onCreate={onCreate}
      open={forced || undefined}
      onOpenChange={(o) => {
        if (!o) {
          onForcedChange(false);
        }
      }}
      renderTrigger={({ open: o, toggle }) => (
        <LabelTriggerButton open={o} toggle={toggle} />
      )}
    />
  );
};

interface ThreadHeaderProps {
  thread: ThreadInfo;
  messages: MessageData[];
  labels: LabelRef[];
  listSearch: ReturnType<typeof listParams>;
  prev: { id: string } | null;
  next: { id: string } | null;
  reading: Reading;
  act: Act;
  onCreateLabel: (name: string) => Promise<LabelRef | null>;
  labelOpen: boolean;
  onLabelOpen: (open: boolean) => void;
  snoozeOpen: boolean;
  onSnoozeOpen: (open: boolean) => void;
}

const ThreadHeader = ({
  thread,
  messages,
  labels,
  listSearch,
  prev,
  next,
  reading,
  act,
  onCreateLabel,
  labelOpen,
  onLabelOpen,
  snoozeOpen,
  onSnoozeOpen,
}: ThreadHeaderProps) => (
  <ViewHeader
    className="print-hidden"
    title={thread.subject}
    count={thread.messageCount > 1 ? thread.messageCount : undefined}
    left={
      <Link
        to="/mail"
        search={listSearch}
        className="text-muted hover:bg-hover hover:text-fg -ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        aria-label="Back to the list"
        title="Back (u)"
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>
    }
  >
    <MoveButtons folder={thread.folder} act={act} />
    <span className="bg-line mx-0.5 hidden h-4 w-px sm:block" />
    {!isJunk(thread.folder) && (
      <SnoozePicker
        forced={snoozeOpen}
        onForcedChange={onSnoozeOpen}
        act={act}
      />
    )}
    <ThreadLabelPicker
      labels={labels}
      applied={thread.labels}
      forced={labelOpen}
      onForcedChange={onLabelOpen}
      onCreate={onCreateLabel}
      act={act}
    />
    <StarButton starred={thread.starred} act={act} />
    <ThreadMenu
      thread={thread}
      messages={messages}
      reading={reading}
      act={act}
    />
    <span className="bg-line mx-0.5 hidden h-4 w-px sm:block" />
    <NeighbourLink thread={prev} search={listSearch} label="Newer (k)">
      <ChevronUp className="h-4 w-4" />
    </NeighbourLink>
    <NeighbourLink thread={next} search={listSearch} label="Older (j)">
      <ChevronDown className="h-4 w-4" />
    </NeighbourLink>
  </ViewHeader>
);

/** The labels, the snooze and the mute the conversation carries, above its messages. */
const ThreadChips = ({
  thread,
  hydrated,
  act,
}: {
  thread: ThreadInfo;
  hydrated: boolean;
  act: Act;
}) => {
  if (thread.labels.length === 0 && !thread.snoozedUntil && !thread.muted) {
    return null;
  }

  return (
    <div className="print-hidden mb-3 flex flex-wrap items-center gap-1.5">
      {thread.labels.map((l) => (
        <LabelChip
          key={l.id}
          label={l}
          onRemove={() => {
            act({ intent: "unlabel", labelId: l.id });
          }}
        />
      ))}
      {thread.snoozedUntil && (
        <span className="bg-amber-soft text-amber inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-xs font-medium">
          <Clock className="h-3 w-3" />
          {hydrated
            ? `Snoozed until ${snoozeLabel(thread.snoozedUntil)}`
            : "Snoozed"}
        </span>
      )}
      {thread.muted && (
        <span className="bg-hover text-muted inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-xs font-medium">
          <BellOff className="h-3 w-3" />
          Muted
        </span>
      )}
    </div>
  );
};

const SpamNotice = ({ messages }: { messages: MessageData[] }) => {
  const why = spamReason(messages);

  if (!why) {
    return (
      <Notice className="print-hidden mb-3">
        This conversation was marked as spam. Links and images in it stay off
        until you load them.
      </Notice>
    );
  }

  return (
    <Notice className="print-hidden mb-3">
      <p>
        {why.by === "score"
          ? "The spam filter put this conversation in Spam:"
          : "This conversation went to Spam on arrival:"}
      </p>
      <ul className="my-1 list-disc pl-5">
        {why.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p>
        Links and images in it stay off until you load them.
        {why.by === "score" &&
          " If it is not spam, press Not spam: the filter learns from it."}
      </p>
    </Notice>
  );
};

/** What the trash and Spam say about the conversation. */
const ThreadNotices = ({
  folder,
  messages,
}: {
  folder: ThreadInfo["folder"];
  messages: MessageData[];
}) => {
  if (folder === "trash") {
    return (
      <Notice className="print-hidden mb-3">
        This conversation is in the trash and will be deleted 30 days after it
        went there.
      </Notice>
    );
  }

  return folder === "spam" ? <SpamNotice messages={messages} /> : null;
};

/** One message of the conversation, hidden while another is printed. */
const ThreadMessage = ({
  message: m,
  origin,
  folder,
  senderRule,
  reading,
  sender,
  composeWith,
}: {
  message: MessageData;
  origin: string;
  folder: ThreadInfo["folder"];
  senderRule: SenderRuleView | null;
  reading: Reading;
  sender: Sender;
  composeWith: (mode: ComposeMode, messageId?: string) => void;
}) => {
  const { printing, print } = reading;
  const { onUnsubscribe, onSender, onBlock } = sender;

  return (
    <div
      className={cx(
        "contents",
        printing && printing !== "all" && printing !== m.id && "print-hidden"
      )}
    >
      <MessageCard
        message={m}
        origin={origin}
        expanded={reading.open.has(m.id)}
        onToggle={() => {
          reading.toggle(m.id);
        }}
        senderRule={senderRule}
        onCompose={(mode, id) => {
          composeWith(mode, id);
        }}
        onUnsubscribe={(msg) => {
          onUnsubscribe(msg);
        }}
        onPrint={print}
        onBlock={onBlock}
        onAlwaysImages={
          folder === "spam"
            ? undefined
            : (msg) => {
                onSender("images", msg.from.email);
              }
        }
        onUnblock={(senderEmail) => {
          onSender("unblock", senderEmail);
        }}
      />
    </div>
  );
};

const ReplyButtons = ({
  composeWith,
}: {
  composeWith: (mode: ComposeMode) => void;
}) => (
  <div className="flex items-center gap-2">
    <Button
      variant="secondary"
      onClick={() => {
        composeWith("reply");
      }}
      title="Reply (r)"
    >
      <Reply className="h-3.5 w-3.5" />
      Reply
    </Button>
    <Button
      variant="secondary"
      onClick={() => {
        composeWith("all");
      }}
      title="Reply all (a)"
    >
      <ReplyAll className="h-3.5 w-3.5" />
      Reply all
    </Button>
    <Button
      variant="secondary"
      onClick={() => {
        composeWith("forward");
      }}
      title="Forward (f)"
    >
      <Forward className="h-3.5 w-3.5" />
      Forward
    </Button>
  </div>
);

const ReplyBox = ({
  ref,
  compose,
  canReply,
  composeWith,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>;
  compose: ComposeData | null;
  canReply: boolean;
  composeWith: (mode: ComposeMode) => void;
  onClose: () => void;
}) => {
  let body: React.ReactNode = null;

  if (compose) {
    body = (
      <Composer
        key={
          compose.prefill.draftId ??
          `${compose.prefill.mode}:${compose.prefill.inReplyToId}`
        }
        data={compose}
        variant="inline"
        onClose={() => {
          onClose();
        }}
        onSent={() => {
          onClose();
        }}
      />
    );
  } else if (canReply) {
    body = <ReplyButtons composeWith={composeWith} />;
  }

  return (
    <div ref={ref} className="print-hidden mt-4">
      {body}
    </div>
  );
};

const ThreadView = () => {
  const { thread, messages, origin, wasUnread, draftCompose, senderRules } =
    Route.useLoaderData();

  const list = MailRoute.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const run = useThreadActions();
  // The snooze moment is in the reader's time zone, so only once hydrated: the server renders in UTC.
  const hydrated = useHydrated();
  const last = messages.at(-1);
  const reading = useReading(messages, last);

  const { compose, setCompose, replyBox, composeWith } = useReplyBox(
    draftCompose,
    last
  );

  const [labelOpen, setLabelOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const i = list.threads.findIndex((t) => t.id === thread.id);
  const prev = i > 0 ? list.threads[i - 1] : null;
  const next = i === -1 ? null : (list.threads[i + 1] ?? null);
  const listSearch = listParams(list);

  // The list's row goes from bold to plain as soon as the conversation is read.
  const invalidatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (invalidatedFor.current === thread.id) {
      return;
    }

    invalidatedFor.current = thread.id;

    if (wasUnread) {
      router.invalidate();
    }
  }, [thread.id, wasUnread, router]);

  const back = () => {
    navigate({ to: "/mail", search: listSearch });
  };

  // An action that leaves the conversation goes back to the list first: the row is gone from it already, and the
  // action finishes behind it without reloading this conversation on the way out.
  const act: Act = async (action, leave = false) => {
    if (leave) {
      back();
    }

    await run([thread.id], action);
  };

  const sender = useSenderActions(thread.id, back);
  const onCreateLabel = useCreateLabel();

  useThreadShortcuts(thread, {
    act,
    back,
    composeWith: (mode) => {
      composeWith(mode);
    },
    toggleAll: reading.toggleAll,
    openSnooze: () => {
      setSnoozeOpen(true);
    },
    openLabels: () => {
      setLabelOpen(true);
    },
  });

  return (
    <>
      <ThreadHeader
        thread={thread}
        messages={messages}
        labels={list.labels}
        listSearch={listSearch}
        prev={prev}
        next={next}
        reading={reading}
        act={act}
        onCreateLabel={onCreateLabel}
        labelOpen={labelOpen}
        onLabelOpen={setLabelOpen}
        snoozeOpen={snoozeOpen}
        onSnoozeOpen={setSnoozeOpen}
      />

      <div className="print-flow min-h-0 flex-1 overflow-y-auto">
        <div
          className={cx(
            "mx-auto max-w-4xl px-4 py-4",
            reading.printing && "print-flow"
          )}
        >
          <h1 className="print-only mb-4 text-xl font-semibold">
            {thread.subject}
          </h1>
          <ThreadChips thread={thread} hydrated={hydrated} act={act} />
          <ThreadNotices folder={thread.folder} messages={messages} />
          <ol className="space-y-3">
            {messages.map((m) => (
              <ThreadMessage
                key={m.id}
                message={m}
                origin={origin}
                folder={thread.folder}
                senderRule={senderRules[m.from.email] ?? null}
                reading={reading}
                sender={sender}
                composeWith={composeWith}
              />
            ))}
          </ol>
          <ReplyBox
            ref={replyBox}
            compose={compose}
            canReply={Boolean(last)}
            composeWith={composeWith}
            onClose={() => {
              setCompose(null);
            }}
          />
        </div>
      </div>
    </>
  );
};

const ThreadPage = () => {
  const data = Route.useLoaderData();

  // Another conversation gets fresh state: what was open, the reply box, the print choice.
  return <ThreadView key={data.thread.id} />;
};

export const Route = createFileRoute("/_app/mail/t/$threadId")({
  // The conversation stays when the minute's refresh cannot load it again (#3547).
  loader: (run) =>
    keepShown(run, () =>
      getThread({
        data: { threadId: run.params.threadId },
        fetch: serverFnFetch,
      })
    ),
  head: ({ loaderData, matches }) => ({
    meta: [
      {
        title: mailTitle(
          listOf(matches),
          inboxUnreadOf(matches),
          loaderData?.thread.subject ?? "Conversation"
        ),
      },
    ],
  }),
  component: ThreadPage,
});
