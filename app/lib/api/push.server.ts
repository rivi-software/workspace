import { isJsonObject } from "~/lib/guards";
/** The Push section of the Workspace API (docs/API.md, docs/PUSH.md): whether push is on, and the session's subscription. */
import { pushSettings, subscribe, unsubscribe } from "~/lib/push/push.server";

import { field, readBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiRoute } from "./routing.server";

export const pushRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/push",
    handler: async ({ db, env }) => json(await pushSettings(db, env)),
  },
  {
    method: "POST",
    path: "/push/subscriptions",
    writes: true,
    handler: async ({ request, db, env, user, sessionId }) => {
      const body = await readBody(request);
      // `PushSubscription.toJSON()`'s shape: `{ endpoint, keys: { p256dh, auth } }`.
      const keys = isJsonObject(body.keys) ? body.keys : null;

      const { id } = await subscribe(db, env, user, sessionId, {
        endpoint: field(body, "endpoint"),
        p256dh: keys ? field(keys, "p256dh") : "",
        auth: keys ? field(keys, "auth") : "",
      });

      return json({ ok: true, id }, 201);
    },
  },
  {
    method: "DELETE",
    path: "/push/subscriptions/:id",
    writes: true,
    handler: async ({ db, user, params }) => {
      if (!(await unsubscribe(db, user.id, params.id ?? ""))) {
        throw new ApiRequestError("No such subscription.", 404);
      }

      return json({ ok: true });
    },
  },
];
