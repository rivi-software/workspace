/** `GET /api/v1/me`: the person, their counts, labels and preferences, and what the tabs need to start (docs/API.md). */
import { aiEnabled } from "~/lib/ai";
import { SUGGESTIONS } from "~/lib/assistant/assistant";
import { colleagues, storageUsed } from "~/lib/drive/drive.server";
import { sharedMailboxes } from "~/lib/mail/groups.server";
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
      const [counts, labels, driveUsed, people, github, mailboxes] =
        await Promise.all([
          folderCounts(db, user.id),
          listLabels(db, user.id),
          storageUsed(db, user.id),
          colleagues(db, user.id),
          githubConnection(db, user.id),
          // The shared group inboxes the person is in, each with its counts and labels, as the console's sidebar.
          sharedMailboxes(db, user.id).then((boxes) =>
            Promise.all(
              boxes.map(async (box) => ({
                id: box.id,
                name: box.name,
                email: box.email,
                counts: await folderCounts(db, box.id),
                labels: await listLabels(db, box.id),
              }))
            )
          ),
        ]);

      const ai = aiEnabled(env);

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
        mailboxes,
        preferences: parsePreferences(user.preferencesJson),
        driveUsed,
        github: { connected: github !== null },
        colleagues: people,
        assistant: { enabled: ai },
        suggestions: ai ? [...SUGGESTIONS] : [],
      });
    },
  },
];
