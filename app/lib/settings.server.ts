/**
 * What Settings loads: who is looking and the open tab's slice alone, from the module that owns it. A tab only an
 * admin sees opens Account for anyone else (`openTab`), so a member's visit never reads People or Drive. Each tab's
 * forms are its module's intent handler.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";

import { accountSettings } from "./account.server";
import { brandingSettings } from "./branding-settings.server";
import { driveSettings } from "./drive/settings.server";
import { unreachable } from "./guards";
import { mailSettings } from "./mail/settings.server";
import { signatureSettings } from "./mail/signature-settings.server";
import { peopleSettings } from "./people.server";
import { openTab } from "./settings";
import { applicationsSettings } from "./sso/settings.server";
import { tasksSettings } from "./tasks/settings.server";

/** The tab an address's `tab` opens for the person, with what it shows. `request` carries their session. */
export const loadSettings = async (
  db: Database,
  env: Env,
  user: User,
  request: Request,
  asked: string | undefined
) => {
  const tab = openTab(asked, user.role);

  const me = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    lastSignInAt: user.lastSignInAt,
  };

  switch (tab) {
    case "mail": {
      return { tab, me, mail: await mailSettings(db, env, user) };
    }

    case "tasks": {
      return { tab, me, tasks: await tasksSettings(db, user) };
    }

    case "people": {
      return { tab, me, people: await peopleSettings(db, env, user) };
    }

    case "drive": {
      return { tab, me, drive: await driveSettings(db, user) };
    }

    case "branding": {
      return { tab, me, branding: await brandingSettings(db, user) };
    }

    case "applications": {
      return {
        tab,
        me,
        applications: await applicationsSettings(db, env, user),
      };
    }

    case "account": {
      // The person's own account and security, and their mail signatures.
      const [account, signatures] = await Promise.all([
        accountSettings(db, env, user, request),
        signatureSettings(db, user),
      ]);

      return { tab, me, account, signatures };
    }

    default: {
      return unreachable(tab, "Settings tab");
    }
  }
};

export type Settings = Awaited<ReturnType<typeof loadSettings>>;
