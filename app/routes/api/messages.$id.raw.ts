import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { createDb } from "~/db";
import { messages } from "~/db/schema";
import { getSessionUser } from "~/lib/auth.server";
import { MailboxError, mailboxFor } from "~/lib/mail/groups.server";

/** The original message as received (.eml), for its mailbox's owner, or a member of the shared group inbox it is in. */
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
          where: eq(messages.id, params.id),
        });

        // The message's mailbox as the person would open it: theirs, or a shared group inbox they are in.
        let reachable = false;

        if (m) {
          try {
            await mailboxFor(db, user, m.userId);
            reachable = true;
          } catch (error) {
            if (!(error instanceof MailboxError)) {
              throw error;
            }
          }
        }

        if (!reachable || !m?.rawKey) {
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
