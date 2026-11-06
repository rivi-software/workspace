import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";

import { createDb } from "~/db";
import { messages } from "~/db/schema";
import { getSessionUser } from "~/lib/auth.server";

/** The original message as received (.eml), for the owner only. */
export const Route = createFileRoute("/api/messages/$id/raw")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = createDb(env.DB);
        const user = await getSessionUser(request, env, db);

        if (!user) {
          return new Response("unauthorized", { status: 401 });
        }

        const m = await db.query.messages.findFirst({
          where: and(eq(messages.id, params.id), eq(messages.userId, user.id)),
        });

        if (!m?.rawKey) {
          return new Response("not found", { status: 404 });
        }

        const object = await env.MAIL.get(m.rawKey);

        if (!object) {
          return new Response("not found", { status: 404 });
        }

        return new Response(object.body, {
          headers: {
            "Content-Type": "message/rfc822",
            "Content-Disposition": `attachment; filename="${m.id}.eml"`,
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
