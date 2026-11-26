/**
 * Settings → Branding, an admin's: the workspace's accent colour and icon. What the tab loads (`brandingSettings`) and
 * what its form does (`brandingIntent`), apart from the route so the tests call both.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";
import {
  BrandError,
  brandSetting,
  removeBrandIcon,
  setBrandColor,
  setBrandIcon,
} from "~/lib/branding.server";
import { field } from "~/lib/guards";
import type { SettingsResult } from "~/lib/settings";

/** What the Branding tab shows an admin; it refuses anyone else, whom Settings never shows the tab (`openTab`). */
export const brandingSettings = (db: Database, user: User) => {
  if (user.role !== "admin") {
    throw new Error("Only an admin sees the workspace's branding.");
  }

  return brandSetting(db);
};

/**
 * The Branding form, for an admin only: `color` sets the accent (`color`, empty for the default green), `color-reset`
 * goes back to the green, `icon` keeps the uploaded `icon` file, `icon-remove` goes back to the default mark.
 */
export const brandingIntent = async (
  db: Database,
  env: Pick<Env, "DRIVE">,
  user: User,
  form: FormData
): Promise<SettingsResult> => {
  if (user.role !== "admin") {
    return { error: "Only an admin can change this." };
  }

  try {
    switch (field(form, "intent")) {
      case "color": {
        const hex = await setBrandColor(db, user.id, field(form, "color"));

        return {
          message: hex
            ? `The accent is ${hex}.`
            : "The accent is the default green again.",
        };
      }

      case "color-reset": {
        await setBrandColor(db, user.id, "");

        return { message: "The accent is the default green again." };
      }

      case "icon": {
        const file = form.get("icon");

        if (!(file instanceof File) || !file.size) {
          return { error: "Choose an image to upload." };
        }

        await setBrandIcon(db, env, user.id, file);

        return { message: "The workspace's icon is updated." };
      }

      case "icon-remove": {
        await removeBrandIcon(db, env);

        return { message: "The workspace shows the default mark again." };
      }

      default: {
        return { error: "Unknown action." };
      }
    }
  } catch (error) {
    if (error instanceof BrandError) {
      return { error: error.message };
    }

    throw error;
  }
};
