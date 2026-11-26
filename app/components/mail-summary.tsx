import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Markdown } from "~/lib/assistant/markdown";
import { readerZone } from "~/lib/calendar/calendar";

import { Button } from "./ui";

/** How often a summary being written is shown again, at most. */
const SHOW_EVERY_MS = 100;

/** A conversation's summary as the page holds it: nothing, being written, written, or failed. */
export interface ThreadSummaryState {
  text: string;
  status: "writing" | "done" | "failed";
}

/**
 * The summary of the conversation that is open: asked for from its menu, read from `/api/mail/summary` as
 * the model writes it, and gone when it is dismissed or another conversation opens. Nothing of it is kept.
 */
export const useThreadSummary = (threadId: string) => {
  // The summary with the conversation it is of: another conversation has no part in it.
  const [held, setHeld] = useState<
    (ThreadSummaryState & { of: string }) | null
  >(null);

  // The request being read, with the conversation it is of.
  const asked = useRef<{ request: AbortController; of: string } | null>(null);
  const summary = held?.of === threadId ? held : null;

  const setSummary = useCallback(
    (next: ThreadSummaryState | null) => {
      setHeld(next && { ...next, of: threadId });
    },
    [threadId]
  );

  const dismiss = useCallback(() => {
    asked.current?.request.abort();
    asked.current = null;
    setHeld(null);
  }, []);

  // A page that goes away, or another conversation opened in it, asks for nothing more: the summary of the one left
  // is not shown again, so its request ends with it. The layout's refresh keeps `threadId`, and the request.
  useEffect(() => {
    const open = threadId;

    return () => {
      if (asked.current?.of === open) {
        asked.current.request.abort();
        asked.current = null;
      }
    };
  }, [threadId]);

  const summarize = useCallback(async () => {
    asked.current?.request.abort();
    const request = new AbortController();
    asked.current = { request, of: threadId };
    setSummary({ text: "", status: "writing" });

    try {
      const response = await fetch("/api/mail/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, timeZone: readerZone() }),
        signal: request.signal,
      });

      if (!response.ok || !response.body) {
        setSummary({ text: "", status: "failed" });

        return;
      }

      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();

      let text = "";
      let shownAt = 0;

      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read one chunk after the other
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        text += value;

        // The conversation under the card renders with it: a few times a second keeps the summary visibly
        // growing without rendering every message for every word.
        if (performance.now() - shownAt >= SHOW_EVERY_MS) {
          shownAt = performance.now();
          setSummary({ text, status: "writing" });
        }
      }

      setSummary({ text, status: text.trim() ? "done" : "failed" });
    } catch {
      // Dismissed or left, or the connection or the model failed partway (the route errors the stream then, so a
      // summary cut short is never taken for a whole one): only the last two leave a card to say so.
      if (asked.current?.request === request) {
        setSummary({ text: "", status: "failed" });
      }
    }
  }, [threadId, setSummary]);

  return { summary, summarize, dismiss };
};

/** The card above a conversation's messages that holds its summary. */
export const ThreadSummary = ({
  summary,
  onRetry,
  onDismiss,
}: {
  summary: ThreadSummaryState;
  onRetry: () => void;
  onDismiss: () => void;
}) => (
  <section
    aria-label="Summary"
    className="border-line bg-sidebar print-hidden animate-rise-in mb-3 rounded-md border px-3 py-2.5"
  >
    <div className="mb-1 flex items-center gap-1.5">
      <Sparkles className="text-accent h-3.5 w-3.5 shrink-0" />
      <h2 className="text-fg flex-1 text-sm font-medium">Summary</h2>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss the summary"
        className="text-subtle hover:bg-hover hover:text-fg -mr-1 flex h-6 w-6 items-center justify-center rounded-md"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
    {summary.status !== "failed" && summary.text && (
      <Markdown
        text={summary.text}
        className="text-fg text-base leading-5 break-words"
      />
    )}
    {/* Only how the summary stands is announced, not each word of it as it streams in. */}
    <div aria-live="polite">
      {summary.status === "failed" && (
        <div className="text-muted flex flex-wrap items-center gap-2 text-base">
          <span className="flex-1">The summary could not be written.</span>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
      {summary.status === "writing" && !summary.text && (
        <p className="text-subtle text-base">Reading the conversation…</p>
      )}
      {summary.status === "done" && (
        <p className="text-faint mt-1.5 text-sm">
          Written by AI from this conversation. Check what matters against the
          messages.
        </p>
      )}
    </div>
  </section>
);
