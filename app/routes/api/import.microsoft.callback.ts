import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { finishMicrosoftConnect } from "~/lib/mail/import/connect.server";

/** Where Microsoft sends the browser back after the person chose a mailbox and allowed reading it. */
export const Route = createFileRoute("/api/import/microsoft/callback")({
  server: {
    handlers: {
      GET: ({ request }) =>
        finishMicrosoftConnect(request, env, createDb(env.DB)),
    },
  },
});
