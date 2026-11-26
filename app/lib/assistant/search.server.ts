import type { Database } from "~/db";
import type { DriveRow } from "~/lib/drive/drive";
import { rowsByIds, sharingOwners } from "~/lib/drive/drive.server";
import { conversationsByIds } from "~/lib/mail/mail.server";
import type { ConversationSummary } from "~/lib/mail/mail.server";
import { searchIndexFor } from "~/lib/search/index.server";

/**
 * The assistant's searches by meaning: a question in the person's words asked of the index
 * (`app/lib/search/`), and every hit read back through Mail's or Drive's own gate, in the index's order. The index
 * only proposes: a conversation that moved to Spam or the trash, a file that was unshared or trashed, and anything
 * that is not the person's to see is not answered, whatever the index holds. Null where this Worker has no index, or
 * it did not answer: the caller then searches by words.
 */

/** How many hits are asked of the index for the rows wanted: some will not pass the gate. */
const SPARE = 3;

/** At most this many colleagues' files are looked among beside the person's own: a query of the index each. */
const MAX_SHARING_OWNERS = 10;

const asked = async <T>(
  what: string,
  search: () => Promise<T[]>
): Promise<T[] | null> => {
  try {
    return await search();
  } catch (error) {
    // The index is a help, never a reason for a search to fail.
    console.error("assistant.search", { what, error: String(error) });

    return null;
  }
};

/** The person's conversations nearest to what `about` says, outside Spam and the trash. */
export const mailByMeaning = async (
  env: Env,
  db: Database,
  userId: string,
  about: string,
  limit: number
): Promise<ConversationSummary[] | null> => {
  const index = searchIndexFor(env);

  if (!index) {
    return null;
  }

  return await asked("mail", async () => {
    const hits = await index.find([userId], "mail", about, limit * SPARE);

    const rows = await conversationsByIds(
      db,
      userId,
      hits.map((h) => h.id)
    );

    return rows.slice(0, limit);
  });
};

export interface FilesByMeaning {
  rows: DriveRow[];
  /** How many colleagues who share with the person were left out of the search, past the most it asks of. */
  unsearched: number;
}

/** The files nearest to what `about` says, among the person's own and what colleagues share with them. */
export const filesByMeaning = async (
  env: Env,
  db: Database,
  userId: string,
  about: string,
  limit: number
): Promise<FilesByMeaning | null> => {
  const index = searchIndexFor(env);

  if (!index) {
    return null;
  }

  // The index is a help, never a reason for a search to fail: whatever goes wrong on the way answers null.
  const found = await asked("drive", async () => {
    // A file is indexed under its owner, so a colleague's shared files are found among that colleague's, and the
    // gate keeps the ones this person reaches.
    const sharing = await sharingOwners(db, userId);
    const owners = sharing.slice(0, MAX_SHARING_OWNERS);

    const hits = await index.find(
      [userId, ...owners],
      "drive",
      about,
      limit * SPARE
    );

    const reached = await rowsByIds(
      db,
      userId,
      hits.map((h) => h.id)
    );

    return [
      {
        rows: reached.slice(0, limit),
        unsearched: sharing.length - owners.length,
      },
    ];
  });

  return found?.[0] ?? null;
};
