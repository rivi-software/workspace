import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { githubConnections } from "~/db/schema";
import type { User } from "~/db/schema";
import {
  GitHubError,
  assignedIssues,
  connectGitHub,
  disconnectGitHub,
  githubConnection,
  githubFor,
  looksLikeToken,
} from "~/lib/tasks/github.server";
import type { Fetch } from "~/lib/tasks/github.server";
import { dueLabel, groupTasks, parseIssueRef } from "~/lib/tasks/tasks";
import type { AssignedIssue } from "~/lib/tasks/tasks";
import {
  addIssueTask,
  createTask,
  deleteTask,
  getTask,
  linkIssue,
  listTasks,
  refreshLinkedIssues,
  setTaskDone,
  tasksDue,
  updateTask,
} from "~/lib/tasks/tasks.server";

import { db, defined, mailbox, rejection, rejectionIncludes } from "./fixtures";

const TOKEN = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

interface FakeIssue {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  assigned: boolean;
  pull?: boolean;
}

const restIssue = (i: FakeIssue) => ({
  number: i.number,
  title: i.title,
  html_url: `https://github.com/${i.repo}/issues/${i.number}`,
  state: i.state,
  updated_at: "2026-10-30T12:00:00.000Z",
  repository_url: `https://api.github.com/repos/${i.repo}`,
  labels: [{ name: "support" }],
  pull_request: i.pull ? {} : undefined,
});

/** What the fake answers with: a failure, the account, an issue or the list of them. */
type GitHubAnswer =
  | { message: string }
  | { login: string; name: string }
  | ReturnType<typeof restIssue>
  | ReturnType<typeof restIssue>[];

const json = (status: number, body: GitHubAnswer) =>
  Response.json(body, { status });

/**
 * GitHub in memory behind a `fetch`: the account the token belongs to, the issues it reaches (the assigned ones
 * listed by `/issues`), one looked up and one closed or reopened. `refuse` fails every call with that status.
 */
const fakeGitHub = (
  issues: FakeIssue[],
  opts: {
    refuse?: number;
    login?: string;
    renamed?: Record<string, string>;
  } = {}
) => {
  const calls: { method: string; path: string; body: unknown }[] = [];

  const answer = (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : input);

    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const auth = new Headers(init?.headers).get("authorization");

    if (auth !== `Bearer ${TOKEN}`) {
      return json(401, { message: "Bad credentials" });
    }

    if (opts.refuse) {
      return json(opts.refuse, { message: "Refused" });
    }

    if (url.pathname === "/user") {
      return json(200, { login: opts.login ?? "rikvisser", name: "Rik" });
    }

    if (url.pathname === "/issues") {
      return json(
        200,
        issues.flatMap((i) =>
          i.assigned && i.state === "open" ? [restIssue(i)] : []
        )
      );
    }

    const m = url.pathname.match(
      /^\/repos\/(?<repo>[^/]+\/[^/]+)\/issues\/(?<number>\d+)$/u
    );

    if (m) {
      // GitHub finds a repository by its name case aside, and under its old name once renamed or moved, and
      // answers with the name it has now.
      const asked = (
        opts.renamed?.[defined(m[1])] ?? defined(m[1])
      ).toLowerCase();

      const issue = issues.find(
        (i) => i.repo.toLowerCase() === asked && i.number === Number(m[2])
      );

      if (!issue) {
        return json(404, { message: "Not Found" });
      }

      if (method === "PATCH") {
        issue.state = body.state;
      }

      return json(200, restIssue(issue));
    }

    return json(404, { message: "Not Found" });
  };

  const fetchFn: Fetch = (input, init) => Promise.resolve(answer(input, init));

  return { fetch: fetchFn, calls, issues };
};

const taskRow = (
  id: string,
  dueOn: string | null,
  priority: "low" | "normal" | "high" = "normal"
) => ({
  id,
  title: id,
  notes: "",
  status: "open" as const,
  priority,
  dueOn,
  completedAt: null,
  github: null,
  updatedAt: "2026-10-30T00:00:00.000Z",
  createdAt: `2026-10-30T00:00:0${id.length}.000Z`,
});

describe("the vocabulary", () => {
  it("reads an issue reference", () => {
    expect({
      "rivi-software/rivi-monorepo#3111": parseIssueRef(
        "rivi-software/rivi-monorepo#3111"
      ),
      parseIssueRef: parseIssueRef(
        " https://github.com/rivi-software/rivi-monorepo/issues/3111#issuecomment-1 "
      ),
      "https://github.com/rivi-software/rivi-monorepo/pull/3111": parseIssueRef(
        "https://github.com/rivi-software/rivi-monorepo/pull/3111"
      ),
      "rivi-monorepo#3111": parseIssueRef("rivi-monorepo#3111"),
      "a/b#0": parseIssueRef("a/b#0"),
      "": parseIssueRef(""),
      looksLikeToken: looksLikeToken(TOKEN),
      ghp_0123456789abcdefghijklmnop: looksLikeToken(
        "ghp_0123456789abcdefghijklmnop"
      ),
      password: looksLikeToken("password"),
    }).toStrictEqual({
      "rivi-software/rivi-monorepo#3111": {
        repo: "rivi-software/rivi-monorepo",
        number: 3111,
      },
      parseIssueRef: {
        repo: "rivi-software/rivi-monorepo",
        number: 3111,
      },
      "https://github.com/rivi-software/rivi-monorepo/pull/3111": null,
      "rivi-monorepo#3111": null,
      "a/b#0": null,
      "": null,
      looksLikeToken: true,
      ghp_0123456789abcdefghijklmnop: true,
      password: false,
    });
  });

  it("groups open tasks by their due day", () => {
    const groups = groupTasks(
      [
        taskRow("later", "2026-11-10"),
        taskRow("none", null),
        taskRow("today-low", "2026-10-31", "low"),
        taskRow("today-high", "2026-10-31", "high"),
        taskRow("old", "2026-10-01"),
        taskRow("soon", "2026-11-01"),
      ],
      "2026-10-31"
    );

    expect({
      groupsMap: groups.map((g) => [g.key, g.rows.map((r) => r.id)]),
      k20261031: dueLabel("2026-10-31", "2026-10-31"),
      k20261101: dueLabel("2026-11-01", "2026-10-31"),
      k20261030: dueLabel("2026-10-30", "2026-10-31"),
      k20261103: /3/u.test(dueLabel("2026-11-03", "2026-10-31")),
      k20251103: /2025/u.test(dueLabel("2025-11-03", "2026-10-31")),
    }).toStrictEqual({
      groupsMap: [
        ["overdue", ["old"]],
        ["today", ["today-high", "today-low"]],
        ["upcoming", ["soon", "later"]],
        ["someday", ["none"]],
      ],
      k20261031: "Today",
      k20261101: "Tomorrow",
      k20261030: "Yesterday",
      k20261103: true,
      k20251103: true,
    });
  });
});

describe("a person's tasks", () => {
  let ann: User;
  let bo: User;
  beforeAll(async () => {
    ann = await mailbox("task-ann", "Ann Task");
    bo = await mailbox("task-bo", "Bo Task");
  });

  it("makes, lists, changes, finishes and deletes them, each the person's own", async () => {
    const observed: unknown[] = [];

    const plan = await createTask(db, ann.id, {
      title: "  Write the   plan ",
      dueOn: "2026-11-03",
    });

    const later = await createTask(db, ann.id, {
      title: "Later",
      priority: "low",
    });

    await createTask(db, bo.id, { title: "Bo's own", dueOn: "2026-11-03" });
    expect(plan).toMatchObject({
      title: "Write the plan",
      status: "open",
      priority: "normal",
      dueOn: "2026-11-03",
      github: null,
    });
    const tasks = await listTasks(db, ann.id, "open");
    const dueThisWeek = await tasksDue(db, ann.id, "2026-11-02", "2026-11-08");

    observed.push({
      listTasksMap: tasks.map((t) => t.id),
      tasksDueMap: dueThisWeek.map((t) => t.id),
      tasksDue: await tasksDue(db, ann.id, "2026-11-04", "2026-11-08"),
      getTask: await getTask(db, bo.id, plan.id),
    });

    const changed = await updateTask(db, ann.id, plan.id, {
      title: "Write the plan, really",
      notes: "Three pages.\r\n",
      priority: "high",
      dueOn: null,
    });

    expect(changed).toMatchObject({
      title: "Write the plan, really",
      notes: "Three pages.",
      priority: "high",
      dueOn: null,
    });
    observed.push(
      await rejectionIncludes(
        updateTask(db, bo.id, plan.id, { title: "Mine" }),
        "No such task."
      ),
      await rejectionIncludes(
        updateTask(db, ann.id, plan.id, { title: " " }),
        "A task needs a title."
      ),
      await rejectionIncludes(
        updateTask(db, ann.id, plan.id, { dueOn: "tomorrow" }),
        "The due day is not a date."
      ),
      await rejectionIncludes(
        createTask(db, ann.id, { title: "x", priority: "urgent" }),
        "Choose a priority."
      )
    );

    const done = await setTaskDone(env, db, ann.id, plan.id, true);
    expect(done).toMatchObject({ ok: true, github: "unlinked" });
    const tasks2 = await listTasks(db, ann.id, "open");
    observed.push(tasks2.map((t) => t.id));
    const finished = await listTasks(db, ann.id, "done");
    observed.push({
      finishedMap: finished.map((t) => t.id),
      completedAt: Boolean(defined(finished[0]).completedAt),
    });
    await setTaskDone(env, db, ann.id, plan.id, false);
    observed.push(
      defined(await getTask(db, ann.id, plan.id)).completedAt,
      Boolean(await deleteTask(db, bo.id, plan.id)),
      Boolean(await deleteTask(db, ann.id, plan.id)),
      Boolean(await deleteTask(db, ann.id, later.id))
    );

    expect(observed).toStrictEqual([
      // { listTasksMap: tasks.map((t) => t.id), tasksDueMap: (await tasksDue(db, ann.id, "2026-...
      {
        listTasksMap: [plan.id, later.id],
        tasksDueMap: [plan.id],
        tasksDue: [],
        getTask: null,
      },
      // (await rejection(updateTask(db, bo.id, plan.id, { title: "Mine" })))?.message.includes(...
      true,
      // (await rejection(updateTask(db, ann.id, plan.id, { title: " " })))?.message.includes("A...
      true,
      // (await rejection(updateTask(db, ann.id, plan.id, { dueOn: "tomorrow" })))?.message.incl...
      true,
      // (await rejection(createTask(db, ann.id, { title: "x", priority: "urgent" })))?.message....
      true,
      // tasks2.map((t) => t.id)
      [later.id],
      // { finishedMap: finished.map((t) => t.id), completedAt: Boolean(defined(finished[0]).com...
      { finishedMap: [plan.id], completedAt: true },
      // defined(await getTask(db, ann.id, plan.id)).completedAt
      null,
      // Boolean(await deleteTask(db, bo.id, plan.id))
      false,
      // Boolean(await deleteTask(db, ann.id, plan.id))
      true,
      // Boolean(await deleteTask(db, ann.id, later.id))
      true,
    ]);
  });
});

describe("tasks and GitHub", () => {
  let gil: User;
  beforeAll(async () => {
    gil = await mailbox("task-gil", "Gil Hub");
  });

  it("connects with a token of the person's own, kept sealed, and lists their assigned issues", async () => {
    const observed: unknown[] = [];

    const github = fakeGitHub([
      {
        repo: "rivi-software/rivi-monorepo",
        number: 3111,
        title: "Calendar and Tasks",
        state: "open",
        assigned: true,
      },
      {
        repo: "rivi-software/rivi-monorepo",
        number: 3000,
        title: "Someone else's",
        state: "open",
        assigned: false,
      },
      {
        repo: "rivi-software/tools",
        number: 12,
        title: "A pull request",
        state: "open",
        assigned: true,
        pull: true,
      },
    ]);

    observed.push(
      (await rejection(
        connectGitHub(env, db, gil.id, "not a token", github.fetch)
      )) instanceof GitHubError,
      await rejectionIncludes(
        connectGitHub(
          env,
          db,
          gil.id,
          "ghp_wrongwrongwrongwrongwrong",
          github.fetch
        ),
        "GitHub refused the token"
      ),
      {
        githubConnection: await githubConnection(db, gil.id),
        assignedIssues: await assignedIssues(env, db, gil.id, github.fetch),
        connectGitHub: await connectGitHub(
          env,
          db,
          gil.id,
          ` ${TOKEN}\n`,
          github.fetch
        ),
      }
    );

    const row = defined(
      await db.query.githubConnections.findFirst({
        where: eq(githubConnections.userId, gil.id),
      })
    );

    observed.push(row.login, row.tokenSealed.includes(TOKEN));
    await expect(githubConnection(db, gil.id)).resolves.toMatchObject({
      login: "rikvisser",
      name: "Rik",
    });

    const work = await assignedIssues(env, db, gil.id, github.fetch);
    observed.push(
      { connected: work.connected, issues: work.issues },
      github.calls.at(-1)?.path.includes("/issues?filter=assigned&state=open")
    );

    // GitHub down: the page's section is left out, never failed.
    const down = fakeGitHub([], { refuse: 503 });
    observed.push(await assignedIssues(env, db, gil.id, down.fetch));

    expect(observed).toStrictEqual([
      // (await rejection(connectGitHub(env, db, gil.id, "not a token", github.fetch))) instance...
      true,
      // (await rejection(connectGitHub( env, db, gil.id, "ghp_wrongwrongwrongwrongwrong", githu...
      true,
      // { githubConnection: await githubConnection(db, gil.id), assignedIssues: await assignedI...
      {
        githubConnection: null,
        assignedIssues: {
          connected: false,
          issues: null,
        },
        connectGitHub: {
          login: "rikvisser",
          name: "Rik",
        },
      },
      // row.login
      "rikvisser",
      // row.tokenSealed.includes(TOKEN)
      false,
      // { connected: work.connected, issues: work.issues }
      {
        connected: true,
        issues: [
          {
            repo: "rivi-software/rivi-monorepo",
            number: 3111,
            title: "Calendar and Tasks",
            url: "https://github.com/rivi-software/rivi-monorepo/issues/3111",
            state: "open",
            updatedAt: "2026-10-30T12:00:00.000Z",
            labels: ["support"],
          },
        ],
      },
      // github.calls.at(-1)?.path.includes("/issues?filter=assigned&state=open")
      true,
      // assignedIssues(env, db, gil.id, down.fetch)
      {
        connected: true,
        issues: null,
      },
    ]);
  });

  it("makes a task from an issue, closes the issue when the task is done and reopens it with the task", async () => {
    const observed: unknown[] = [];
    const observedSubsets: unknown[] = [];

    const github = fakeGitHub([
      {
        repo: "rivi-software/rivi-monorepo",
        number: 3111,
        title: "Calendar and Tasks",
        state: "open",
        assigned: true,
      },
    ]);

    const ref = { repo: "rivi-software/rivi-monorepo", number: 3111 };
    const made = await addIssueTask(env, db, gil.id, ref, github.fetch);
    observed.push(Boolean(made.existed));
    observedSubsets.push(made.task);
    observed.push(Boolean(defined(made.task.github).syncedAt));
    // Once per issue: adding it again answers the task the person has.
    const again = await addIssueTask(env, db, gil.id, ref, github.fetch);
    observedSubsets.push(again);
    observed.push(
      await rejectionIncludes(
        addIssueTask(
          env,
          db,
          gil.id,
          { repo: "rivi-software/nothing", number: 1 },
          github.fetch
        ),
        "GitHub has no issue rivi-software/nothing#1 you can see."
      )
    );

    const done = await setTaskDone(
      env,
      db,
      gil.id,
      made.task.id,
      true,
      github.fetch
    );

    observedSubsets.push(done);
    observed.push({
      state: defined(github.issues[0]).state,
      callsAt: github.calls.at(-1),
      state2: defined(defined(await getTask(db, gil.id, made.task.id)).github)
        .state,
    });

    const reopened = await setTaskDone(
      env,
      db,
      gil.id,
      made.task.id,
      false,
      github.fetch
    );

    observedSubsets.push(reopened);
    observed.push(defined(github.issues[0]).state);

    // GitHub refusing keeps the task as it was.
    const refusing = fakeGitHub(github.issues, { refuse: 403 });

    const refused = await setTaskDone(
      env,
      db,
      gil.id,
      made.task.id,
      true,
      refusing.fetch
    );

    observed.push({
      refused,
      status: defined(await getTask(db, gil.id, made.task.id)).status,
    });

    expect(observed).toStrictEqual([
      // Boolean(made.existed)
      false,
      // Boolean(defined(made.task.github).syncedAt)
      true,
      // (await rejection(addIssueTask( env, db, gil.id, { repo: "rivi-software/nothing", number...
      true,
      // { state: defined(github.issues[0]).state, callsAt: github.calls.at(-1), state2: defined...
      {
        state: "closed",
        callsAt: {
          method: "PATCH",
          path: "/repos/rivi-software/rivi-monorepo/issues/3111",
          body: { state: "closed", state_reason: "completed" },
        },
        state2: "closed",
      },
      // defined(github.issues[0]).state
      "open",
      // { refused, status: defined(await getTask(db, gil.id, made.task.id)).status, }
      {
        refused: {
          ok: false,
          error: "GitHub answered 403: Refused",
        },
        status: "open",
      },
    ]);

    // A done issue the person adds again comes back as an open task.
    await setTaskDone(env, db, gil.id, made.task.id, true, github.fetch);
    const back = await addIssueTask(env, db, gil.id, ref, github.fetch);
    observedSubsets.push(back);

    expect(observedSubsets).toMatchObject([
      // made.task
      {
        title: "Calendar and Tasks",
        github: {
          repo: "rivi-software/rivi-monorepo",
          number: 3111,
          url: "https://github.com/rivi-software/rivi-monorepo/issues/3111",
          title: "Calendar and Tasks",
          state: "open",
        },
      },
      // again
      { existed: true, task: { id: made.task.id } },
      // done
      {
        ok: true,
        github: "closed",
        task: { status: "done" },
      },
      // reopened
      {
        ok: true,
        github: "reopened",
        task: { status: "open" },
      },
      // back
      {
        existed: true,
        task: { id: made.task.id, status: "open" },
      },
    ]);
    await setTaskDone(env, db, gil.id, made.task.id, false, github.fetch);
  });

  it("links a task to an issue, one task per issue, keeps what GitHub lists and lets the link go", async () => {
    const observed: unknown[] = [];

    const github = fakeGitHub([
      {
        repo: "rivi-software/rivi-monorepo",
        number: 3111,
        title: "Calendar and Tasks",
        state: "open",
        assigned: true,
      },
      {
        repo: "rivi-software/tools",
        number: 7,
        title: "Bump deploy-watch",
        state: "open",
        assigned: true,
      },
    ]);

    const plain = await createTask(db, gil.id, { title: "Bump the tools" });
    observed.push(
      await rejectionIncludes(
        linkIssue(
          env,
          db,
          gil.id,
          plain.id,
          { repo: "rivi-software/rivi-monorepo", number: 3111 },
          github.fetch
        ),
        "Another task of yours is already rivi-software/rivi-monorepo#3111."
      ),
      // The name in another case, or the repository's old name: GitHub's own name decides, before any write.
      await rejectionIncludes(
        linkIssue(
          env,
          db,
          gil.id,
          plain.id,
          { repo: "Rivi-Software/Rivi-Monorepo", number: 3111 },
          github.fetch
        ),
        "Another task of yours is already rivi-software/rivi-monorepo#3111."
      )
    );

    const moved = fakeGitHub(github.issues, {
      renamed: { "rivi-software/old-monorepo": "rivi-software/rivi-monorepo" },
    });

    observed.push(
      await rejectionIncludes(
        linkIssue(
          env,
          db,
          gil.id,
          plain.id,
          { repo: "rivi-software/old-monorepo", number: 3111 },
          moved.fetch
        ),
        "Another task of yours is already rivi-software/rivi-monorepo#3111."
      )
    );
    await expect(
      addIssueTask(
        env,
        db,
        gil.id,
        { repo: "rivi-software/old-monorepo", number: 3111 },
        moved.fetch
      )
    ).resolves.toMatchObject({
      existed: true,
      task: { github: { repo: "rivi-software/rivi-monorepo" } },
    });
    const tasks = await listTasks(db, gil.id, "open");
    observed.push(tasks.filter((t) => t.github?.number === 3111).length);

    const linked = await linkIssue(
      env,
      db,
      gil.id,
      plain.id,
      { repo: "rivi-software/tools", number: 7 },
      github.fetch
    );

    expect(linked.github).toMatchObject({
      repo: "rivi-software/tools",
      number: 7,
      title: "Bump deploy-watch",
    });
    observed.push(linked.title);

    // GitHub lists the issue with a new title: the task keeps it.
    defined(github.issues[1]).title = "Bump deploy-watch to 0.2";

    const assignedIssuesResult = await assignedIssues(
      env,
      db,
      gil.id,
      github.fetch
    );

    const issues: AssignedIssue[] = defined(assignedIssuesResult.issues);

    observed.push({
      refreshLinkedIssues: await refreshLinkedIssues(db, gil.id, issues),
      title: defined(defined(await getTask(db, gil.id, plain.id)).github).title,
      refreshLinkedIssues2: await refreshLinkedIssues(db, gil.id, issues),
    });

    const unlinked = await linkIssue(
      env,
      db,
      gil.id,
      plain.id,
      null,
      github.fetch
    );

    observed.push({ github: unlinked.github, title: unlinked.title });

    expect(observed).toStrictEqual([
      // (await rejection(linkIssue( env, db, gil.id, plain.id, { repo: "rivi-software/rivi-mono...
      true,
      // (await rejection(linkIssue( env, db, gil.id, plain.id, { repo: "Rivi-Software/Rivi-Mono...
      true,
      // (await rejection(linkIssue( env, db, gil.id, plain.id, { repo: "rivi-software/old-monor...
      true,
      // tasks.filter((t) => t.github?.number === 3111).length
      1,
      // linked.title
      "Bump the tools",
      // { refreshLinkedIssues: await refreshLinkedIssues(db, gil.id, issues), title: defined(de...
      {
        refreshLinkedIssues: 1,
        title: "Bump deploy-watch to 0.2",
        refreshLinkedIssues2: 0,
      },
      // { github: unlinked.github, title: unlinked.title }
      {
        github: null,
        title: "Bump the tools",
      },
    ]);
    await deleteTask(db, gil.id, plain.id);
  });

  it("finishes a linked task without a connection, the issue untouched, and forgets the token on disconnect", async () => {
    const observed: unknown[] = [];

    const github = fakeGitHub([
      {
        repo: "rivi-software/rivi-monorepo",
        number: 3111,
        title: "Calendar and Tasks",
        state: "open",
        assigned: true,
      },
    ]);

    const tasks = await listTasks(db, gil.id, "open");
    const task = defined(tasks.find((t) => t.github?.number === 3111));

    observed.push(
      Boolean(await disconnectGitHub(db, gil.id)),
      Boolean(await disconnectGitHub(db, gil.id)),
      await githubFor(env, db, gil.id, github.fetch)
    );

    const done = await setTaskDone(
      env,
      db,
      gil.id,
      task.id,
      true,
      github.fetch
    );

    expect(done).toMatchObject({
      ok: true,
      github: "not-connected",
      task: { status: "done" },
    });
    observed.push(
      defined(github.issues[0]).state,
      await rejectionIncludes(
        addIssueTask(
          env,
          db,
          gil.id,
          { repo: "rivi-software/tools", number: 9 },
          github.fetch
        ),
        "Connect GitHub under Settings → Tasks first."
      )
    );

    expect(observed).toStrictEqual([
      // Boolean(await disconnectGitHub(db, gil.id))
      true,
      // Boolean(await disconnectGitHub(db, gil.id))
      false,
      // githubFor(env, db, gil.id, github.fetch)
      null,
      // defined(github.issues[0]).state
      "open",
      // (await rejection(addIssueTask( env, db, gil.id, { repo: "rivi-software/tools", number: ...
      true,
    ]);
  });
});
