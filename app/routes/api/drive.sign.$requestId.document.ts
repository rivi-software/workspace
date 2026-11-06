import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { getSessionUser } from "~/lib/auth.server";
import { signingDocument } from "~/lib/drive/signing.server";

/**
 * A signing request's PDF (#2974) for the person who sent it and its RIVI signer: the copy that was sent, or with
 * `?signed=1` the signed copy once there is one. The editor's and the request page's pdf.js read it.
 */
export const Route = createFileRoute("/api/drive/sign/$requestId/document")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = createDb(env.DB);
        const user = await getSessionUser(request, env, db);

        if (!user) {
          return new Response("unauthorized", { status: 401 });
        }

        const signed = new URL(request.url).searchParams.get("signed") === "1";

        const res = await signingDocument(
          env,
          db,
          user.id,
          params.requestId,
          signed
        );

        return res ?? new Response("not found", { status: 404 });
      },
    },
  },
});
