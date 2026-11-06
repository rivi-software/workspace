import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { getSessionUser } from "~/lib/auth.server";
import { handleDriveUpload } from "~/lib/drive/upload.server";

const unauthorized = () =>
  Response.json({ ok: false, error: "Sign in first." }, { status: 401 });

/**
 * Files on their way into Drive, from the uploader (`app/components/drive/uploads.tsx`): the session cookie is the
 * gate (SameSite=Lax keeps another site from posting here), and `handleDriveUpload` (`app/lib/drive/upload.server.ts`)
 * does the rest, as it does for the app on a phone.
 */
export const Route = createFileRoute("/api/drive/upload")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        const db = createDb(env.DB);
        const user = await getSessionUser(request, env, db);

        return user
          ? await handleDriveUpload(request, env, db, user)
          : unauthorized();
      },
      POST: async ({ request }) => {
        const db = createDb(env.DB);
        const user = await getSessionUser(request, env, db);

        return user
          ? await handleDriveUpload(request, env, db, user)
          : unauthorized();
      },
    },
  },
});
