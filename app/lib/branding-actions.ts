/**
 * Settings → Branding's server function. A plain module, so the tab's component calls it; it imports
 * `branding-settings.server.ts` for its handler only.
 */
import { createServerFn } from "@tanstack/react-start";

import { brandingIntent } from "~/lib/branding-settings.server";
import { formData, formPost } from "~/lib/forms";
import { appContext } from "~/lib/request.server";
import type { SettingsResult } from "~/lib/settings";

/** Settings → Branding's forms, for an admin, which `brandingIntent` does. */
export const brandingAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SettingsResult> => {
    const { db, env, user } = await appContext();

    return brandingIntent(db, env, user, data);
  });
