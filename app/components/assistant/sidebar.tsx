import { Link } from "@tanstack/react-router";
import { MessageSquare, Plus } from "lucide-react";

import type { ConversationRef } from "~/lib/assistant/assistant";

import { cx } from "../ui";

/** The Assistant's part of the sidebar: a new conversation, and the recent ones. */
export const AssistantSidebar = ({
  conversations,
  activeId,
}: {
  conversations: ConversationRef[];
  activeId: string | null;
}) => (
  <>
    <div className="px-3 pb-3">
      <Link
        to="/assistant"
        search={{}}
        className="bg-accent text-accent-fg hover:bg-accent-hover flex h-7 w-full items-center justify-center gap-1.5 rounded-md px-2.5 text-base font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_1px_rgb(0_0_0/0.08)] transition-colors"
        title="New conversation (⌘J)"
      >
        <Plus className="h-3.5 w-3.5" />
        New conversation
      </Link>
    </div>
    <nav
      className="flex-1 overflow-y-auto px-2 pb-2"
      aria-label="Conversations"
    >
      <div className="text-subtle mb-1 px-2 text-xs font-medium">Recent</div>
      <ul className="space-y-px">
        {conversations.map((c) => {
          const active = c.id === activeId;

          return (
            <li key={c.id}>
              <Link
                to="/assistant/c/$conversationId"
                params={{ conversationId: c.id }}
                className={cx(
                  "flex h-7 items-center gap-2 rounded-md px-2 text-base transition-colors duration-100",
                  active
                    ? "bg-active text-fg"
                    : "text-muted hover:bg-hover hover:text-fg"
                )}
                aria-current={active ? "page" : undefined}
                title={c.title}
              >
                <MessageSquare className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{c.title}</span>
              </Link>
            </li>
          );
        })}
        {!conversations.length && (
          <li className="text-subtle px-2 py-1 text-xs">
            None yet. Ask something to start one.
          </li>
        )}
      </ul>
    </nav>
  </>
);
