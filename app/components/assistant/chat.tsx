import { getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { DefaultChatTransport } from "ai";
import type { ChatStatus } from "ai";
import {
  ArrowUp,
  Check,
  CircleAlert,
  Loader2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";

import { useAction } from "~/lib/action";
import { deleteConversationAction } from "~/lib/assistant/actions";
import {
  SUGGESTIONS,
  isToolPart,
  stepView,
  toUIMessages,
} from "~/lib/assistant/assistant";
import type {
  AssistantMessage,
  ConversationRef,
  StoredMessage,
  ToolPart,
} from "~/lib/assistant/assistant";
import { Markdown } from "~/lib/assistant/markdown";
import { defined, isJsonObject, stringOrNull } from "~/lib/guards";

import { useToast } from "../toast";
import {
  Avatar,
  Button,
  IconButton,
  Kbd,
  LinkButton,
  Menu,
  MenuItem,
  Notice,
  ViewHeader,
  cx,
} from "../ui";
import { useChat } from "./use-chat";

const appRoute = getRouteApi("/_app");

/** What a failed request said, out of the error the SDK made of its response. */
const errorText = (error: Error): string => {
  const text = error.message;
  const json = text.match(/\{.*\}/su)?.[0];

  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      const message = isJsonObject(parsed) ? stringOrNull(parsed.error) : null;

      if (message !== null) {
        return message;
      }
    } catch {
      // Not JSON after all.
    }
  }

  return text || "The assistant could not answer.";
};

const AssistantMark = () => (
  <span
    className="bg-accent-soft text-accent flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
    aria-hidden
  >
    <Sparkles className="h-3 w-3" />
  </span>
);

const UserMessage = ({
  message,
  name,
}: {
  message: AssistantMessage;
  name: string;
}) => {
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  return (
    <div className="flex gap-3">
      <Avatar name={name} size={20} className="mt-px" />
      <div className="min-w-0 flex-1">
        <div className="text-fg mb-1 text-sm font-medium">{name}</div>
        <div className="text-fg text-base leading-5 break-words whitespace-pre-wrap">
          {text}
        </div>
      </div>
    </div>
  );
};

const StepIcon = ({
  running,
  failed,
}: {
  running: boolean;
  failed: boolean;
}) => {
  if (running) {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  }

  if (failed) {
    return <CircleAlert className="text-amber h-3.5 w-3.5 shrink-0" />;
  }

  return <Check className="h-3.5 w-3.5 shrink-0" />;
};

/** One thing the assistant did on the way to its answer. */
const Step = ({ part }: { part: ToolPart }) => {
  const view = stepView(part);
  const router = useRouter();

  return (
    <div className="text-subtle animate-fade-in flex items-center gap-1.5 text-sm">
      <StepIcon running={view.running} failed={view.failed} />
      <span className="min-w-0 truncate">
        {view.label}
        {view.detail && <span className="text-faint"> · {view.detail}</span>}
      </span>
      {view.link && !view.running && (
        <a
          href={view.link}
          className="text-accent shrink-0 underline-offset-2 hover:underline"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
              return;
            }

            e.preventDefault();
            void router.navigate({ href: defined(view.link, "the link") });
          }}
        >
          Open
        </a>
      )}
    </div>
  );
};

/** An answer's parts in order: its text as Markdown, each tool call as a step; a text part is keyed by its turn. */
const answerParts = (message: AssistantMessage) => {
  const out: React.ReactNode[] = [];
  let texts = 0;

  for (const part of message.parts) {
    if (part.type === "text") {
      texts += 1;

      if (part.text.trim()) {
        out.push(
          <Markdown
            key={`text-${texts}`}
            text={part.text}
            className="text-fg text-base leading-5 break-words"
          />
        );
      }
    } else if (isToolPart(part)) {
      out.push(<Step key={part.toolCallId} part={part} />);
    }
  }

  return out;
};

const AssistantAnswer = ({
  message,
  streaming,
}: {
  message: AssistantMessage;
  streaming: boolean;
}) => (
  <div className="flex gap-3">
    <AssistantMark />
    <div className="min-w-0 flex-1">
      <div className="text-fg mb-1 text-sm font-medium">Assistant</div>
      <div className="space-y-2">
        {answerParts(message)}
        {streaming && (
          <span className="sr-only">The assistant is writing.</span>
        )}
      </div>
    </div>
  </div>
);

const Welcome = ({ onPick }: { onPick: (text: string) => void }) => (
  <div className="animate-fade-in flex flex-col items-center px-6 py-6 text-center">
    <div className="border-line bg-elevated text-subtle mb-3 flex h-9 w-9 items-center justify-center rounded-lg border">
      <Sparkles className="h-4 w-4" />
    </div>
    <div className="text-md text-fg font-medium">
      Ask about your mail and files
    </div>
    <p className="text-muted mt-1 max-w-md text-base">
      The assistant searches your mail and Drive, reads a conversation or a file
      when asked, and can prepare a draft that you review and send. It changes
      nothing by itself.
    </p>
    <div className="mt-5 flex flex-wrap justify-center gap-1.5">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="border-line bg-elevated text-muted hover:border-line-strong hover:text-fg h-7 rounded-md border px-2.5 text-sm shadow-[0_1px_1px_rgb(0_0_0/0.04)] transition-colors"
        >
          {s}
        </button>
      ))}
    </div>
  </div>
);

const MAX_ROWS_PX = 200;

/** The transport of one chat, which posts the person's newest message to the conversation it continues: the one open, then the one the first answer named. */
const createAsker = (conversationId: string | null) => {
  let continuing = conversationId;

  return {
    transport: new DefaultChatTransport<AssistantMessage>({
      api: "/api/assistant/chat",
      prepareSendMessagesRequest: ({ messages: all, trigger }) => ({
        body: {
          conversationId: continuing,
          message: all.toReversed().find((m) => m.role === "user") ?? null,
          retry: trigger === "regenerate-message",
        },
      }),
    }),
    continueWith: (id: string) => {
      continuing = id;
    },
  };
};

const Composer = ({
  initial,
  busy,
  onSend,
  onStop,
  autoFocus,
}: {
  initial?: string;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  autoFocus: boolean;
}) => {
  const [value, setValue] = useState(initial ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  const fittedTo = useRef<string | null>(null);
  useEffect(() => {
    const el = area.current;

    if (!el || fittedTo.current === value) {
      return;
    }

    fittedTo.current = value;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) {
      area.current?.focus();
    }
  }, [autoFocus]);

  const submit = (e?: SubmitEvent) => {
    e?.preventDefault();

    if (busy || !value.trim()) {
      return;
    }

    onSend(value);
    setValue("");
  };

  return (
    <div className="border-line print-hidden shrink-0 border-t px-4 py-3">
      <form
        onSubmit={submit}
        className="border-line bg-elevated focus-within:border-accent mx-auto max-w-3xl rounded-lg border shadow-[0_1px_1px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] duration-150 focus-within:ring-2 focus-within:ring-(--ring)"
      >
        <textarea
          ref={area}
          name="question"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          aria-label="Your question"
          placeholder="Ask about your mail and files…"
          className="text-fg placeholder:text-subtle block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base leading-5 focus:outline-none"
        />
        <div className="flex h-9 items-center justify-between gap-2 px-2 pb-1">
          <span className="text-subtle hidden items-center gap-1 text-xs sm:flex">
            <Kbd>↵</Kbd> to send, <Kbd>⇧ ↵</Kbd> for a new line
          </span>
          <span className="sm:hidden" />
          {busy ? (
            <Button size="sm" onClick={onStop}>
              <Square className="h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={!value.trim()}
              className={cx(!value.trim() && "opacity-50")}
            >
              <ArrowUp className="h-3.5 w-3.5" />
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
};

const AssistantChat = ({
  conversation,
  initial,
  prompt,
}: {
  conversation: ConversationRef | null;
  initial: AssistantMessage[];
  prompt?: string;
}) => {
  const { user } = appRoute.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();

  const openConversation = async (id: string) => {
    await navigate({
      to: "/assistant/c/$conversationId",
      params: { conversationId: id },
      replace: true,
    });
    await router.invalidate();
  };

  // The conversation the next question continues: the one open, or the one the first answer named.
  const [asker, setAsker] = useState(() =>
    createAsker(conversation?.id ?? null)
  );

  void setAsker;

  const chat = useChat<AssistantMessage>({
    id: conversation?.id ?? "new",
    messages: initial,
    transport: asker.transport,
    onFinish: ({ message, isAbort, isError }) => {
      const id = message.metadata?.conversationId;

      if (id) {
        asker.continueWith(id);
      }

      if (isError) {
        return;
      }

      // A new conversation has a page of its own once its first answer is stored (the stream ends after that),
      // and the sidebar learns of it; an existing one only moves up the sidebar.
      if (!conversation && id && !isAbort) {
        void openConversation(id);
      } else {
        void router.invalidate();
      }
    },
  });

  const { messages, status, error } = chat;
  const busy = status === "submitted" || status === "streaming";

  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  const scrolledFor = useRef<{
    messages: AssistantMessage[];
    status: ChatStatus;
  } | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    const last = scrolledFor.current;
    scrolledFor.current = { messages, status };

    // A reader at the bottom stays there as messages arrive or their status changes.
    if (!el || !stuck.current) {
      return;
    }

    if (last?.messages === messages && last.status === status) {
      return;
    }

    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const onScroll = () => {
    const el = scroller.current;

    if (!el) {
      return;
    }

    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = (text: string) => {
    const trimmed = text.trim();

    if (!trimmed || busy) {
      return;
    }

    stuck.current = true;
    void chat.sendMessage({ text: trimmed });
  };

  const last = messages.at(-1);

  const waiting =
    status === "submitted" ||
    (status === "streaming" &&
      (!last || last.role !== "assistant" || !last.parts.length));

  // Nothing asked yet: the welcome sits in the middle of the pane rather than at the top of an empty one.
  const fresh = !messages.length && !busy;

  return (
    <>
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div
          className={cx(
            "mx-auto flex max-w-3xl flex-col px-4 py-6",
            fresh && "min-h-full justify-center"
          )}
        >
          {fresh && <Welcome onPick={send} />}
          <ol className="space-y-6">
            {messages.map((m) => (
              <li key={m.id}>
                {m.role === "user" ? (
                  <UserMessage message={m} name={user.name} />
                ) : (
                  <AssistantAnswer message={m} streaming={busy && m === last} />
                )}
              </li>
            ))}
            {waiting && (
              <li className="text-subtle animate-fade-in flex items-center gap-2 text-sm">
                <AssistantMark />
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Thinking…
              </li>
            )}
          </ol>
          {error && status === "error" && (
            <Notice
              tone="error"
              className="mt-4"
              onDismiss={() => chat.clearError()}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-1">{errorText(error)}</span>
                <Button
                  size="sm"
                  onClick={() => {
                    void chat.regenerate();
                  }}
                >
                  Try again
                </Button>
              </div>
            </Notice>
          )}
        </div>
      </div>
      <Composer
        initial={prompt}
        busy={busy}
        onSend={send}
        onStop={() => {
          void chat.stop();
        }}
        autoFocus={!messages.length || !!prompt}
      />
    </>
  );
};

/** The Assistant page: its header, and the conversation (a new one when none is given) with its composer. */
export const AssistantPage = ({
  conversation,
  messages,
  prompt,
}: {
  conversation: ConversationRef | null;
  messages: StoredMessage[];
  prompt?: string;
}) => {
  const navigate = useNavigate();
  const toast = useToast();

  const del = useAction(deleteConversationAction, {
    id: conversation?.id ?? "",
  });

  const remove = async () => {
    if (!conversation) {
      return;
    }

    if (
      // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
      !confirm("Delete this conversation? Its messages cannot be recovered.")
    ) {
      return;
    }

    const result = await del.submit({});

    if (!result) {
      toast.show({
        message: del.error ?? "The conversation could not be deleted.",
        tone: "error",
      });

      return;
    }

    toast.show({ message: "Conversation deleted." });
    void navigate({ to: "/assistant", search: {} });
  };

  return (
    <>
      <ViewHeader title={conversation?.title ?? "Assistant"}>
        <LinkButton
          to="/assistant"
          search={{}}
          size="sm"
          title="New conversation (⌘J)"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </LinkButton>
        {conversation && (
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
            <MenuItem
              danger
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => {
                void remove();
              }}
            >
              Delete conversation
            </MenuItem>
          </Menu>
        )}
      </ViewHeader>
      <AssistantChat
        key={conversation?.id ?? "new"}
        conversation={conversation}
        initial={toUIMessages(messages)}
        prompt={prompt}
      />
    </>
  );
};
