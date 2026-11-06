import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { customerDocument } from "~/lib/drive/signing.server";

/**
 * The PDF on the customer's signing page (#2974): no session, the token and the pass of a confirmed code are the
 * gate (`customerDocument`). The copy that was sent while it is being signed, the signed copy with `?signed=1`.
 */
export const Route = createFileRoute("/s/sign/$token_/document")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        customerDocument(
          env,
          createDb(env.DB),
          request,
          params.token,
          new URL(request.url).searchParams.get("signed") === "1"
        ),
    },
  },
});
