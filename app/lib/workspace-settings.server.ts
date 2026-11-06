/**
 * Workspace-wide settings an admin changes (`workspace_settings`, Settings → Drive). A key without a row has its
 * default, so a fresh database needs no seed; the row records who changed it last, and when.
 */
import { eq } from "drizzle-orm";

import type { Database } from "~/db";
import { users, workspaceSettings } from "~/db/schema";

import { nowIso } from "./ids";

/** Whether people may share Drive's files and folders outside the workspace (#2836). On unless an admin turned it off. */
const EXTERNAL_SHARING = "drive.external-sharing";

export const externalSharingOn = async (db: Database): Promise<boolean> => {
  const row = await db.query.workspaceSettings.findFirst({
    where: eq(workspaceSettings.key, EXTERNAL_SHARING),
  });

  return row?.value !== "off";
};

/**
 * Turn sharing outside the workspace on or off. Off, nobody makes a link or an invite and every existing one answers
 * as if it did not exist; nothing is deleted, so turning it on again brings them back as they were.
 */
export const setExternalSharing = async (
  db: Database,
  adminId: string,
  on: boolean
) => {
  const value = on ? "on" : "off";
  await db
    .insert(workspaceSettings)
    .values({ key: EXTERNAL_SHARING, value, updatedBy: adminId })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedBy: adminId, updatedAt: nowIso() },
    });
};

/** The switch as Settings → Drive shows it: its state, and who set it last, and when. */
export const externalSharingSetting = async (db: Database) => {
  const [row] = await db
    .select({
      value: workspaceSettings.value,
      at: workspaceSettings.updatedAt,
      by: users.name,
    })
    .from(workspaceSettings)
    .leftJoin(users, eq(users.id, workspaceSettings.updatedBy))
    .where(eq(workspaceSettings.key, EXTERNAL_SHARING));

  return {
    on: row?.value !== "off",
    updatedBy: row?.by ?? null,
    updatedAt: row?.at ?? null,
  };
};
