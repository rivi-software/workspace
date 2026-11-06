import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () =>
        Response.json({
          ok: true,
          app: env.APP_NAME,
          mailDomain: env.MAIL_DOMAIN,
          time: new Date().toISOString(),
        }),
    },
  },
});
