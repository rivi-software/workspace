import { createFileRoute } from "@tanstack/react-router";
import { MailOpen } from "lucide-react";

import { Kbd } from "~/components/ui";

const NothingOpen = () => (
  <div className="text-muted animate-fade-in flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
    <div className="border-line bg-elevated text-subtle flex h-10 w-10 items-center justify-center rounded-lg border">
      <MailOpen className="h-4 w-4" />
    </div>
    <div className="text-base">Choose a conversation to read it here.</div>
    <div className="text-subtle flex items-center gap-1.5 text-sm">
      <Kbd>j</Kbd>
      <Kbd>k</Kbd>
      <span>move</span>
      <Kbd className="ml-2">Enter</Kbd>
      <span>open</span>
      <Kbd className="ml-2">?</Kbd>
      <span>all shortcuts</span>
    </div>
  </div>
);

/** The right pane of the split view with nothing open: the list is beside it. */
export const Route = createFileRoute("/_app/mail/")({
  component: NothingOpen,
});
