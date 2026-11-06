import { Import } from "lucide-react";
import { useState } from "react";

import { useAction } from "~/lib/action";
import { mailSettingsAction } from "~/lib/mail/actions";
import type { ImportView } from "~/lib/mail/import/import.server";

import { Button, Notice, Pill, Section, Timestamp, buttonClass } from "./ui";

export interface ImportSettings {
  /** Whether Workspace is registered with Microsoft (the Entra application's id and secret are set). */
  configured: boolean;
  latest: ImportView | null;
}

interface Outcome {
  tone: "success" | "error";
  text: string;
}

/** How the last connection went, from the `connect` and `reason` Microsoft's callback put on the URL. */
const OUTCOMES = new Map<string, Outcome>(
  Object.entries({
    started: {
      tone: "success",
      text: "Connected. The import has started and runs in the background, also with this page closed.",
    },
    declined: {
      tone: "error",
      text: "You did not allow Workspace to read the mailbox, so nothing was imported.",
    },
    expired: {
      tone: "error",
      text: "The connection took too long or was started in another browser. Connect again.",
    },
    failed: { tone: "error", text: "The mailbox could not be connected." },
    unavailable: {
      tone: "error",
      text: "Importing from Microsoft 365 is not set up yet.",
    },
  } satisfies Record<string, Outcome>)
);

const number = (n: number) => n.toLocaleString("en-GB");

const Running = ({ view }: { view: ImportView }) => {
  const act = useAction(mailSettingsAction);
  const handled = view.imported + view.duplicates + view.leftOut;
  const share = view.total ? Math.min(1, handled / view.total) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-base font-medium">
          From {view.account}
        </span>
        <Pill tone="accent">Importing</Pill>
      </div>
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a `progress` element is drawn by the browser; this bar is a styled track whose fill eases between values
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={view.total}
        aria-valuenow={Math.min(handled, view.total)}
        className="bg-hover h-1.5 overflow-hidden rounded-full"
      >
        <div
          className="bg-accent h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
      <p className="tnum text-muted text-sm">
        {number(handled)} of about {number(view.total)} messages:{" "}
        {number(view.imported)} copied
        {view.duplicates > 0 && <>, {number(view.duplicates)} already here</>}
        {view.leftOut > 0 && <>, {number(view.leftOut)} left out</>}. It goes on
        by itself, a batch a minute, also with this page closed.
      </p>
      {view.lastError && (
        <p className="text-subtle text-xs">
          The last batch stopped early ({view.lastError}); the next one picks up
          where it left off.
        </p>
      )}
      <act.Form>
        <input type="hidden" name="id" value={view.id} />
        <Button
          type="submit"
          size="sm"
          name="intent"
          value="import-cancel"
          loading={act.state === "submitting"}
          onClick={(e) => {
            // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
            if (!confirm("Stop the import? What it copied so far stays.")) {
              e.preventDefault();
            }
          }}
        >
          Cancel import
        </Button>
      </act.Form>
    </div>
  );
};

const Finished = ({ view }: { view: ImportView }) => {
  const [showLeftOut, setShowLeftOut] = useState(false);

  const status = {
    done: { tone: "accent" as const, label: "Done" },
    failed: { tone: "red" as const, label: "Stopped" },
    cancelled: { tone: "neutral" as const, label: "Cancelled" },
    running: { tone: "accent" as const, label: "Importing" },
  }[view.status];

  return (
    <div className="border-line bg-sidebar space-y-1.5 rounded-md border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-base font-medium">
          From {view.account}
        </span>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      <p className="tnum text-muted text-sm">
        {number(view.imported)} copied
        {view.duplicates > 0 && <>, {number(view.duplicates)} already here</>}
        {view.leftOut > 0 && <>, {number(view.leftOut)} left out</>}
        {view.finishedAt && (
          <>
            {" · "}
            <Timestamp iso={view.finishedAt} relative={false} />
          </>
        )}
      </p>
      {view.status === "failed" && view.lastError && (
        <p className="text-red text-sm">{view.lastError}</p>
      )}
      {view.leftOutList.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowLeftOut((s) => !s)}
            aria-expanded={showLeftOut}
            className="text-muted hover:text-fg text-sm underline-offset-2 hover:underline"
          >
            {showLeftOut ? "Hide what was left out" : "What was left out?"}
          </button>
          {showLeftOut && (
            <ul className="text-muted space-y-0.5 text-sm">
              {view.leftOutList.map((m) => (
                <li
                  key={`${m.date}|${m.subject}|${m.reason}`}
                  className="flex gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">{m.subject}</span>
                  <span className="text-subtle shrink-0">
                    <Timestamp iso={m.date} relative={false} /> · {m.reason}
                  </span>
                </li>
              ))}
              {view.leftOut > view.leftOutList.length && (
                <li className="text-subtle">
                  and {number(view.leftOut - view.leftOutList.length)} more
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

/**
 * Settings → Mail → Import: connect a Microsoft 365 mailbox and watch its mail come in, a batch a minute (the page
 * refreshes with the rest of the console). What was left out, and why, shows once it is done.
 */
export const MailImport = ({
  settings,
  connect,
  reason,
}: {
  settings: ImportSettings;
  connect?: string;
  reason?: string;
}) => {
  const [dismissed, setDismissed] = useState(false);
  const { latest } = settings;
  const outcome = connect ? OUTCOMES.get(connect) : undefined;

  return (
    <Section title="Import mail">
      <div className="space-y-3 p-4">
        {outcome && !dismissed && (
          <Notice tone={outcome.tone} onDismiss={() => setDismissed(true)}>
            {outcome.text}
            {reason && outcome.tone === "error" && (
              <span className="block text-sm">{reason}</span>
            )}
          </Notice>
        )}
        {latest?.status === "running" ? (
          <Running view={latest} />
        ) : (
          <>
            {latest && <Finished view={latest} />}
            <p className="text-muted text-base">
              Copy the mail of a Microsoft 365 mailbox (Outlook, Exchange
              Online) into this one, oldest first. Inbox comes to the inbox and
              Sent Items under Sent. Your own folders and Outlook&apos;s
              categories become labels, flags become stars, and what you read
              stays read. Deleted Items, Junk Email and Drafts stay behind.
              Workspace only reads the mailbox and changes nothing in it; mail
              already here is not copied twice.
            </p>
            {settings.configured ? (
              <a
                href="/api/import/microsoft/start"
                className={buttonClass("primary")}
              >
                <Import className="h-3.5 w-3.5" />
                {latest ? "Connect a mailbox again" : "Connect Microsoft 365"}
              </a>
            ) : (
              <p className="text-subtle text-sm">
                Not set up yet: an admin registers Workspace with Microsoft once
                (README, Microsoft 365 import).
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  );
};
