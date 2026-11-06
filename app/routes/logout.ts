import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { authFor } from "~/lib/auth.server";
import { redirectWithCookies } from "~/lib/sign-in.server";

export const Route = createFileRoute("/logout")({
  server: {
    handlers: {
      GET: () =>
        new Response(null, { status: 302, headers: { Location: "/login" } }),
      // Better Auth ends the session and answers the cookie that clears it; the sign-in page is next.
      POST: async ({ request }) => {
        const auth = await authFor(env);

        return redirectWithCookies(
          "/login",
          await auth.api.signOut({ headers: request.headers, asResponse: true })
        );
      },
    },
  },
});
