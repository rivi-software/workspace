/**
 * Settings → Drive, an admin's (#2836): sharing outside the workspace, and the record of every link and invite. What
 * the tab loads (`driveSettings`) and what its form does (`driveSettingsIntent`), apart from `driveAdminAction` so the
 * tests call both.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { field } from "~/lib/guards";
import type { SettingsResult } from "~/lib/settings";
import {
  externalSharingSetting,
  setExternalSharing,
} from "~/lib/workspace-settings.server";

import { externalShareRecords } from "./links.server";

/** What the Drive tab shows an admin; it refuses anyone else, whom Settings never shows the tab (`openTab`). */
export const driveSettings = async (db: Database, user: User) => {
  if (user.role !== "admin") {
    throw new Error("Only an admin sees Drive's settings.");
  }

  const [sharing, records] = await Promise.all([
    externalSharingSetting(db),
    externalShareRecords(db),
  ]);

  return { sharing, records };
};

/** The Drive form, for an admin only: `external-sharing` turns sharing outside the workspace on (`on` checked) or off. */
export const driveSettingsIntent = async (
  db: Database,
  _env: Env,
  user: User,
  form: FormData
): Promise<SettingsResult> => {
  if (user.role !== "admin") {
    return { error: "Only an admin can change this." };
  }

  if (field(form, "intent") !== "external-sharing") {
    return { error: "Unknown action." };
  }

  const on = form.get("on") === "on";
  await setExternalSharing(db, user.id, on);
  console.log(
    JSON.stringify({ event: "drive.external-sharing", on, by: user.id })
  );

  return {
    message: on
      ? "Sharing outside the workspace is on."
      : "Sharing outside the workspace is off. Existing links stay off until it is on again.",
  };
};
