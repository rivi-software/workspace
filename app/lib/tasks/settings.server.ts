/**
 * Settings → Tasks (#3111): the person's own GitHub connection. What the tab loads (`tasksSettings`) and what its
 * form does (`githubIntent`), apart from `githubAction` so the tests call both; the connection itself is
 * `github.server.ts`'s.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { field } from "~/lib/guards";

import {
  GitHubError,
  connectGitHub,
  disconnectGitHub,
  githubConnection,
  githubErrorMessage,
} from "./github.server";
import type { Fetch } from "./github.server";

/** The person's GitHub connection, or null when they have none. */
export const tasksSettings = async (db: Database, user: User) => ({
  github: await githubConnection(db, user.id),
});

export interface GitHubConnectResult {
  error?: string;
  message?: string;
}

/**
 * The Tasks form: `connect` with a `token` of the person's own, or `disconnect`. `fetchFn` is GitHub, which a test
 * lays its own over. An intent it does not know is refused.
 */
export const githubIntent = async (
  db: Database,
  env: Env,
  user: User,
  form: FormData,
  fetchFn?: Fetch
): Promise<GitHubConnectResult> => {
  const intent = field(form, "intent");

  try {
    if (intent === "connect") {
      const me = await connectGitHub(
        env,
        db,
        user.id,
        field(form, "token"),
        fetchFn
      );

      console.log(
        JSON.stringify({
          event: "github.connected",
          by: user.id,
          login: me.login,
        })
      );

      return {
        message: `Connected as ${me.login}. Your assigned issues are on the Tasks page.`,
      };
    }

    if (intent === "disconnect") {
      await disconnectGitHub(db, user.id);
      console.log(
        JSON.stringify({ event: "github.disconnected", by: user.id })
      );

      return {
        message:
          "Disconnected. The token is gone; your tasks stay, their issues untouched.",
      };
    }
  } catch (error) {
    if (error instanceof GitHubError) {
      return { error: githubErrorMessage(error) };
    }

    throw error;
  }

  return { error: "Unknown action." };
};
