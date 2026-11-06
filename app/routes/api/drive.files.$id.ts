import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { getSessionUser } from "~/lib/auth.server";
import { reachFile } from "~/lib/drive/access.server";
import { fileResponse } from "~/lib/drive/serve.server";

/**
 * A file in Drive, for its owner and the people it is shared with: the session is the gate, then the share. Shown
 * inline when the browser can, `?download=1` always as a download, with Range and its own sandbox CSP
 * (`fileResponse`, which a link's file route serves through too).
 */
export const Route = createFileRoute("/api/drive/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = createDb(env.DB);
        const user = await getSessionUser(request, env, db);

        if (!user) {
          return new Response("unauthorized", { status: 401 });
        }

        // The owner previews a file they trashed from their trash.
        const file = await reachFile(db, user.id, params.id, "own-trash");

        if (!file) {
          return new Response("not found", { status: 404 });
        }

        const download =
          new URL(request.url).searchParams.get("download") === "1";

        const res = await fileResponse(request, env.DRIVE, file, {
          download,
          cacheControl: "private, max-age=3600",
        });

        return res ?? new Response("not found", { status: 404 });
      },
    },
  },
});
