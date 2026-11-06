import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { sharedFileResponse } from "~/lib/drive/links.server";

/**
 * A file's bytes through a link outside the workspace (#2836): no session, the token is the gate (`openLink`, then
 * `reachFileByLink`), served as the session's file route serves it (`fileResponse`: the sandbox CSP, the attachment,
 * Range). Not nested under the page `/s/$token`: it only answers.
 */
export const Route = createFileRoute("/s/$token_/file/$nodeId")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        sharedFileResponse(
          env,
          createDb(env.DB),
          request,
          params.token,
          params.nodeId
        ),
    },
  },
});
