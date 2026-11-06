import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { AssistantPage } from "~/components/assistant/chat";
import { SectionError } from "~/components/section-error";
import { getConversation } from "~/lib/assistant/chat.server";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { assistantTitle } from "./assistant";

const getConversationData = createServerFn()
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const { db, user } = await appContext();
    const found = await getConversation(db, user.id, data.id);

    if (!found) {
      throw notFound();
    }

    return found;
  });

const ConversationPage = () => {
  const { conversation, messages } = Route.useLoaderData();

  return <AssistantPage conversation={conversation} messages={messages} />;
};

/** What takes a conversation's place when it cannot load and there is nothing to keep (#3548). */
const ConversationError = ({ error }: ErrorComponentProps) => (
  <SectionError error={error} title="The conversation didn't load" />
);

export const Route = createFileRoute("/_app/assistant/c/$conversationId")({
  // The conversation stays when the minute's refresh cannot load it again (#3548).
  loader: (run) =>
    keepShown(run, () =>
      getConversationData({
        data: { id: run.params.conversationId },
        fetch: serverFnFetch,
      })
    ),
  head: ({ loaderData }) => ({
    meta: [
      { title: assistantTitle(loaderData?.conversation.title ?? "Assistant") },
    ],
  }),
  component: ConversationPage,
  errorComponent: ConversationError,
});
