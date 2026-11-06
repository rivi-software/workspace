import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { createDb } from "~/db";
import { attachments } from "~/db/schema";
import { verifyFileSignature } from "~/lib/mail/files.server";

const INLINE_TYPES =
  /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/u;

/** A message's file by its signed link (`signFileUrl`): no session, the signature and its expiry are the gate. */
export const Route = createFileRoute("/api/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);

        if (
          !(await verifyFileSignature(
            env,
            params.id,
            url.searchParams.get("exp"),
            url.searchParams.get("sig")
          ))
        ) {
          return new Response("forbidden", { status: 403 });
        }

        const db = createDb(env.DB);

        const att = await db.query.attachments.findFirst({
          where: eq(attachments.id, params.id),
        });

        if (!att) {
          return new Response("not found", { status: 404 });
        }

        const object = await env.MAIL.get(att.r2Key);

        if (!object) {
          return new Response("not found", { status: 404 });
        }

        const inline =
          INLINE_TYPES.test(att.contentType) &&
          url.searchParams.get("download") !== "1";

        const filename = att.filename.replaceAll(/["\r\n]/gu, "_");

        return new Response(object.body, {
          headers: {
            "Content-Type": att.contentType,
            "Content-Length": String(att.size),
            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            // A PDF or an SVG served inline must never run script against this origin.
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        });
      },
    },
  },
});
