import { Outlet, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";

import { Empty } from "~/components/ui";

const appRoute = getRouteApi("/_app");

/**
 * The Assistant: a new conversation at `/assistant`, an existing one at `/assistant/c/$conversationId`. With
 * `AI_FEATURES` off (`app/lib/ai.ts`) the section only says so: the console links nowhere here, but an old
 * bookmark still lands.
 */
const AssistantSection = () => {
  const { ai } = appRoute.useLoaderData();

  if (!ai) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <Empty
          icon={<Sparkles className="h-4 w-4" />}
          title="The Assistant is off"
        >
          This workspace has its AI features turned off.
        </Empty>
      </div>
    );
  }

  return <Outlet />;
};

export const Route = createFileRoute("/_app/assistant")({
  component: AssistantSection,
});

export const assistantTitle = (name: string): string => `${name} · Workspace`;
