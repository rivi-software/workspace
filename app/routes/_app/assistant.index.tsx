import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { AssistantPage } from "~/components/assistant/chat";

import { assistantTitle } from "./assistant";

// The router keeps search values as strings; a prompt of digits would otherwise come back as a number.
const searchSchema = z.object({
  // A question to start with, written into the composer and not sent ("Ask the assistant" on a conversation).
  prompt: z.coerce.string().optional(),
});

const NewConversation = () => {
  const { prompt } = Route.useSearch();

  return <AssistantPage conversation={null} messages={[]} prompt={prompt} />;
};

export const Route = createFileRoute("/_app/assistant/")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: assistantTitle("Assistant") }] }),
  component: NewConversation,
});
