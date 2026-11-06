/**
 * GitHub for a person's Tasks (#3111): their own connection (a personal access token they paste under Settings →
 * Tasks, kept sealed in `github_connections`) and the few calls Tasks makes with it: who the token belongs to, the
 * open issues assigned to them, one issue looked up, and an issue closed or reopened when its task is marked done or
 * reopened. Every call takes a `fetch` so the tests bring their own GitHub (`test/tasks.test.ts`); nothing here is
 * reached by a test otherwise. API: https://docs.github.com/en/rest
 */
import { eq } from "drizzle-orm";

import type { Database } from "~/db";
import { githubConnections } from "~/db/schema";
import { errorMessage, isJsonObject, stringOrNull } from "~/lib/guards";
import { callLink } from "~/lib/link";
import { openSecret, sealSecret } from "~/lib/secret-box.server";

import { ISSUE_REPO } from "./tasks";
import type { AssignedIssue } from "./tasks";

export type Fetch = typeof fetch;

export interface GitHubViewer {
  login: string;
  name: string | null;
}

/** An issue by where it lives: `owner/name` and its number. */
export interface IssueRef {
  repo: string;
  number: number;
}

export class GitHubError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export interface GitHubClient {
  /** The account the token belongs to. */
  viewer: () => Promise<GitHubViewer>;
  /** The open issues assigned to the account, the last changed first; pull requests left out. */
  assigned: () => Promise<AssignedIssue[]>;
  /** The issue at this reference, or null when GitHub has none there (a pull request is no issue). */
  lookup: (ref: IssueRef) => Promise<AssignedIssue | null>;
  /** Close an issue as completed, or open it again. */
  setState: (ref: IssueRef, state: "open" | "closed") => Promise<AssignedIssue>;
}

const API = "https://api.github.com";

/** The Tasks page waits no longer for the assigned issues. */
const LIST_TIMEOUT_MS = 3000;
const TIMEOUT_MS = 8000;

/** How many assigned issues the page lists. */
const ASSIGNED_LIMIT = 50;

/** The purpose a token is sealed under (`sealSecret`), so a value sealed for anything else never opens as one. */
const TOKEN_PURPOSE = "github-token";

/** An issue as the REST API answers it, as far as Tasks reads it. */
interface RestIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  repository_url: string;
  labels?: ({ name?: string } | string)[];
  pull_request?: unknown;
}

const fromRest = (issue: RestIssue): AssignedIssue => ({
  repo: issue.repository_url.slice(`${API}/repos/`.length),
  number: issue.number,
  title: issue.title,
  url: issue.html_url,
  state: issue.state.toLowerCase() === "closed" ? "closed" : "open",
  updatedAt: issue.updated_at,
  labels: (issue.labels ?? [])
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- GitHub answers a label as its name or as an object; the two are told apart at runtime
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean),
});

const repoPath = (repo: string): string => {
  if (!ISSUE_REPO.test(repo)) {
    throw new GitHubError(`“${repo}” is no repository: owner/name.`);
  }

  return `/repos/${repo}`;
};

/** What a refused call says, in words a person reads: GitHub's own message when its body has one. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- an error body is whatever GitHub answered; only a string `message` is read
const failureText = (status: number, body: unknown): string => {
  if (status === 401) {
    return "GitHub refused the token: connect again under Settings → Tasks.";
  }

  const message = isJsonObject(body) ? stringOrNull(body.message) : null;

  return message === null
    ? `GitHub answered ${status}`
    : `GitHub answered ${status}: ${message}`;
};

/** The body of a successful answer; any other throws with GitHub's own message. */
const read = async <T>(res: Response): Promise<T> => {
  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    throw new GitHubError(failureText(res.status, body), res.status);
  }

  if (body === null) {
    throw new GitHubError("GitHub answered without data", res.status);
  }

  // SAFETY: a successful answer has the shape its caller names (GitHub's documented REST bodies); nothing here validates it.
  return body as T;
};

/** A client on one token. */
export const githubClient = (
  token: string,
  fetchFn: Fetch = fetch
): GitHubClient => {
  const api = async (
    path: string,
    ms: number,
    init: { method?: string; body?: unknown } = {}
  ): Promise<Response> => {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Workspace",
      authorization: `Bearer ${token}`,
    });

    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    try {
      return await fetchFn(`${API}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      throw new GitHubError(`GitHub did not answer: ${errorMessage(error)}`);
    }
  };

  return {
    async viewer() {
      const me = await read<{ login: string; name: string | null }>(
        await api("/user", TIMEOUT_MS)
      );

      return { login: me.login, name: me.name ?? null };
    },
    async assigned() {
      const rows = await read<RestIssue[]>(
        await api(
          `/issues?filter=assigned&state=open&sort=updated&direction=desc&per_page=${ASSIGNED_LIMIT}`,
          LIST_TIMEOUT_MS
        )
      );

      return rows.filter((i) => !i.pull_request).map(fromRest);
    },
    async lookup(ref) {
      const path = repoPath(ref.repo);

      if (!Number.isInteger(ref.number) || ref.number < 1) {
        return null;
      }

      const res = await api(`${path}/issues/${ref.number}`, TIMEOUT_MS);

      // 404: GitHub has no issue there, or the token cannot see it; 410: it was deleted.
      if (res.status === 404 || res.status === 410) {
        return null;
      }

      const issue = await read<RestIssue>(res);

      return issue.pull_request ? null : fromRest(issue);
    },
    async setState(ref, state) {
      const issue = await read<RestIssue>(
        await api(`${repoPath(ref.repo)}/issues/${ref.number}`, TIMEOUT_MS, {
          method: "PATCH",
          body:
            state === "closed"
              ? { state, state_reason: "completed" }
              : { state },
        })
      );

      return fromRest(issue);
    },
  };
};

/** What Settings → Tasks shows of a person's connection. */
export interface GitHubConnectionView {
  login: string;
  name: string | null;
  connectedAt: string;
}

export const githubConnection = async (
  db: Database,
  userId: string
): Promise<GitHubConnectionView | null> => {
  const row = await db.query.githubConnections.findFirst({
    where: eq(githubConnections.userId, userId),
  });

  return row
    ? { login: row.login, name: row.name, connectedAt: row.createdAt }
    : null;
};

/** A token as GitHub hands them out: classic (`ghp_`) or fine-grained (`github_pat_`), with nothing around it. */
export const looksLikeToken = (value: string): boolean =>
  /^(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/u.test(value);

/**
 * Connect GitHub for a person: the token is checked (whose is it?), sealed and kept, replacing any connection they
 * had. The token itself is never logged or shown again.
 */
export const connectGitHub = async (
  env: Env,
  db: Database,
  userId: string,
  token: string,
  fetchFn?: Fetch
): Promise<GitHubViewer> => {
  const value = token.trim();

  if (!looksLikeToken(value)) {
    throw new GitHubError(
      "That is no GitHub token: paste a personal access token (ghp_… or github_pat_…)."
    );
  }

  const me = await githubClient(value, fetchFn).viewer();
  const tokenSealed = await sealSecret(env, TOKEN_PURPOSE, value);
  await db
    .insert(githubConnections)
    .values({ userId, login: me.login, name: me.name, tokenSealed })
    .onConflictDoUpdate({
      target: githubConnections.userId,
      set: {
        login: me.login,
        name: me.name,
        tokenSealed,
        createdAt: new Date().toISOString(),
      },
    });

  return me;
};

export const disconnectGitHub = async (
  db: Database,
  userId: string
): Promise<boolean> => {
  const gone = await db
    .delete(githubConnections)
    .where(eq(githubConnections.userId, userId))
    .returning({ userId: githubConnections.userId });

  return gone.length > 0;
};

/**
 * The person's GitHub, or null without a connection. A token that no longer opens (`SESSION_SECRET` rotated since)
 * counts as none: the person connects again.
 */
export const githubFor = async (
  env: Env,
  db: Database,
  userId: string,
  fetchFn?: Fetch
): Promise<GitHubClient | null> => {
  const row = await db.query.githubConnections.findFirst({
    where: eq(githubConnections.userId, userId),
  });

  if (!row) {
    return null;
  }

  const token = await openSecret(env, TOKEN_PURPOSE, row.tokenSealed);

  return token ? githubClient(token, fetchFn) : null;
};

/** What the Tasks page shows of GitHub: whether the person is connected, and their issues when GitHub answered. */
export interface GitHubWork {
  connected: boolean;
  /** Null while not connected, and when GitHub did not answer in time (the page says so). */
  issues: AssignedIssue[] | null;
}

/** The person's assigned issues, never failing the page: a GitHub that does not answer leaves them out. */
export const assignedIssues = async (
  env: Env,
  db: Database,
  userId: string,
  fetchFn?: Fetch
): Promise<GitHubWork> => {
  const client = await githubFor(env, db, userId, fetchFn);

  if (!client) {
    return { connected: false, issues: null };
  }

  const issues = await callLink(
    "github.assigned",
    () => client.assigned(),
    LIST_TIMEOUT_MS + 500
  );

  return { connected: true, issues };
};

/** The message a person reads when a call fails, whatever threw. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause holds whatever was thrown; a GitHubError's message is kept, anything else is described
export const githubErrorMessage = (err: unknown): string =>
  err instanceof GitHubError
    ? err.message
    : `GitHub failed: ${errorMessage(err)}`;
