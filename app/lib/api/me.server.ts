/** `GET /api/v1/me`: the person, their counts, labels and preferences, and what the tabs need to start (docs/API.md). */
import { SUGGESTIONS } from "~/lib/assistant/assistant";
import { colleagues, storageUsed } from "~/lib/drive/drive.server";
import { listLabels } from "~/lib/mail/labels.server";
import { folderCounts } from "~/lib/mail/mailbox.server";
import { parsePreferences } from "~/lib/mail/preferences";
import { githubConnection } from "~/lib/tasks/github.server";

import { json } from "./routing.server";
import type { ApiRoute } from "./routing.server";

export const meRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/me",
    handler: async ({ db, env, user }) => {
      const [counts, labels, driveUsed, people, github] = await Promise.all([
        folderCounts(db, user.id),
        listLabels(db, user.id),
        storageUsed(db, user.id),
        colleagues(db, user.id),
        githubConnection(db, user.id),
      ]);

      return json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        appName: env.APP_NAME,
        counts,
        labels,
        preferences: parsePreferences(user.preferencesJson),
        driveUsed,
        github: { connected: github !== null },
        colleagues: people,
        suggestions: [...SUGGESTIONS],
      });
    },
  },
];
