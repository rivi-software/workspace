import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { startMicrosoftConnect } from "~/lib/mail/import/connect.server";

/** Settings → Mail → Import: off to Microsoft to connect a Microsoft 365 mailbox. */
export const Route = createFileRoute("/api/import/microsoft/start")({
  server: {
    handlers: {
      GET: ({ request }) =>
        startMicrosoftConnect(request, env, createDb(env.DB)),
    },
  },
});
