/**
 * The server functions the Applications tab and the account menu call, which import the `*.server.ts` modules for
 * their handlers only (Start's import protection keeps them out of the client).
 */
import { createServerFn } from "@tanstack/react-start";

import { formData, formPost } from "~/lib/forms";
import { appContext } from "~/lib/request.server";
import type { SettingsResult } from "~/lib/settings";

import { applicationsIntent } from "./settings.server";

/** Settings → Applications' forms, for an admin, which `applicationsIntent` does. */
export const applicationsAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SettingsResult> => {
    const { db, env, user } = await appContext();

    return applicationsIntent(db, env, user, data);
  });
