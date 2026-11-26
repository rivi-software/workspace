import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      // Readable from any origin: the phone app's start page (mobile/src/start.js) reads it to tell a workspace from
      // any other site before it keeps the address a person typed, and what it answers is no secret.
      GET: () =>
        Response.json(
          {
            ok: true,
            app: env.APP_NAME,
            mailDomain: env.MAIL_DOMAIN,
            time: new Date().toISOString(),
          },
          { headers: { "Access-Control-Allow-Origin": "*" } }
        ),
    },
  },
});
