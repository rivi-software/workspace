import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { useRef, useState } from "react";

import { draftWithAiAction } from "~/lib/assistant/actions";
import { readerZone } from "~/lib/calendar/calendar";
import { withCleanup } from "~/lib/cleanup";

import { Button, cx } from "./ui";

/**
 * "Draft with AI" in the composer: the person says in a line what the message should say (or nothing, for a
 * plain answer to the conversation), and the text comes back for the editor, where they change it and send it
 * themselves. It sits in the composer's toolbar, whose form it must never submit: the line has no name, its button
 * is no submit button, and Enter in it drafts.
 */
export const DraftWithAi = ({
  threadId,
  fields,
  onDraft,
  onError,
}: {
  /** The conversation a reply answers; null for a new message or a forward. */
  threadId: string | null;
  /** The composer's recipients and subject as they stand, read when the draft is asked for. */
  fields: () => { to: string; cc: string; subject: string };
  /** The drafted body, as plain text. */
  onDraft: (text: string) => void;
  onError: (message: string) => void;
}) => {
  const write = useServerFn(draftWithAiAction);
  const line = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const draft = async () => {
    if (busy) {
      return;
    }

    const data = new FormData();
    const { to, cc, subject } = fields();
    data.set("threadId", threadId ?? "");
    data.set("instruction", line.current?.value ?? "");
    data.set("to", to);
    data.set("cc", cc);
    data.set("subject", subject);
    data.set("timeZone", readerZone());
    setBusy(true);

    await withCleanup(
      async () => {
        try {
          const result = await write({ data });

          if (result.ok) {
            onDraft(result.text);
            setOpen(false);
          } else {
            onError(result.error);
          }
        } catch {
          onError("The draft could not be written. Try again.");
        }
      },
      () => setBusy(false)
    );
  };

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cx(
          "text-muted hover:bg-hover hover:text-fg inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-base font-medium",
          open && "bg-hover text-fg"
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        Draft with AI
      </button>
      {open && (
        <div className="border-line bg-sidebar animate-rise-in order-first flex basis-full items-center gap-2 rounded-md border py-1 pr-1 pl-2.5">
          <Sparkles className="text-accent h-3.5 w-3.5 shrink-0" />
          <input
            ref={line}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the line opens because the person asked for it
            autoFocus
            aria-label="What the message should say"
            placeholder={
              threadId
                ? "What should the reply say? Leave empty for a plain answer"
                : "Say in a line what the message should say"
            }
            maxLength={2000}
            disabled={busy}
            className="text-fg placeholder:text-subtle h-7 min-w-0 flex-1 bg-transparent text-base outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Enter here drafts; it must not send the message the composer's form holds.
                e.preventDefault();
                void draft();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <Button
            size="sm"
            loading={busy}
            onClick={() => {
              void draft();
            }}
          >
            {busy ? "Writing…" : "Draft"}
          </Button>
        </div>
      )}
    </>
  );
};
