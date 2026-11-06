import { Outlet, createFileRoute } from "@tanstack/react-router";

/** The Assistant: a new conversation at `/assistant`, an existing one at `/assistant/c/$conversationId`. */
export const Route = createFileRoute("/_app/assistant")({
  component: () => <Outlet />,
});

export const assistantTitle = (name: string): string => `${name} · Workspace`;
