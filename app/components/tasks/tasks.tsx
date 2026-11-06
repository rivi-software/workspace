import { Link, useHydrated } from "@tanstack/react-router";
import {
  CircleCheck,
  ExternalLink,
  ListTodo,
  Plus,
  RotateCcw,
  SquareCheckBig,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { todayKey } from "~/lib/calendar/calendar";
import type { DayKey } from "~/lib/calendar/calendar";
import { withCleanup } from "~/lib/cleanup";
import { defined } from "~/lib/guards";
import type { GitHubWork } from "~/lib/tasks/github.server";
import {
  TASK_PRIORITY_LABEL,
  TASK_VIEWS,
  TASK_VIEW_LABEL,
  dueLabel,
  groupTasks,
  issueLabel,
} from "~/lib/tasks/tasks";
import type { AssignedIssue, TaskRow, TaskView } from "~/lib/tasks/tasks";

import { useShortcuts } from "../keyboard";
import {
  Button,
  Checkbox,
  Empty,
  Notice,
  Pill,
  Section,
  Timestamp,
  ViewHeader,
  cx,
  inputClass,
} from "../ui";
import { TaskDialog } from "./task-dialog";
import { useTaskAction } from "./use-task-action";

export interface TasksData {
  view: TaskView;
  tasks: TaskRow[];
  github: GitHubWork;
}

const TaskLine = ({
  task,
  today,
  onOpen,
}: {
  task: TaskRow;
  today: DayKey;
  onOpen: () => void;
}) => {
  const run = useTaskAction();
  const [busy, setBusy] = useState(false);
  const done = task.status === "done";

  const toggle = async () => {
    setBusy(true);

    await withCleanup(
      () => run({ intent: done ? "reopen" : "done", id: task.id }),
      () => setBusy(false)
    );
  };

  const overdue = !done && task.dueOn !== null && task.dueOn < today;
  const finishedAt = done ? task.completedAt : null;

  return (
    <li className="flex items-center gap-3 px-3 py-2" data-task={task.id}>
      <Checkbox
        checked={done}
        onChange={() => {
          toggle();
        }}
        disabled={busy}
        aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
      />
      <button
        type="button"
        onClick={onOpen}
        className={cx(
          "min-w-0 flex-1 truncate text-left text-base hover:underline underline-offset-2",
          done && "text-muted line-through"
        )}
      >
        {task.title}
      </button>
      {task.priority === "high" && !done && (
        <Pill tone="amber">{TASK_PRIORITY_LABEL.high}</Pill>
      )}
      {task.priority === "low" && !done && (
        <Pill>{TASK_PRIORITY_LABEL.low}</Pill>
      )}
      {task.github && (
        <a
          href={task.github.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted hover:text-fg inline-flex shrink-0 items-center gap-1 text-xs"
          title={task.github.title ?? undefined}
        >
          {issueLabel(task.github)}
          {task.github.state === "closed" && (
            <span className="text-subtle">(closed)</span>
          )}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {finishedAt && (
        <span className="text-subtle shrink-0 text-xs">
          <Timestamp iso={finishedAt} />
        </span>
      )}
      {!finishedAt && task.dueOn && (
        <span
          className={cx(
            "tnum shrink-0 text-xs",
            overdue ? "text-red" : "text-subtle"
          )}
        >
          {dueLabel(task.dueOn, today)}
        </span>
      )}
      {done && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            toggle();
          }}
          disabled={busy}
          title="Reopen"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  );
};

const GitHubSection = ({
  work,
  inTasks,
}: {
  work: GitHubWork;
  inTasks: Set<string>;
}) => {
  const run = useTaskAction();
  const [busy, setBusy] = useState<string | null>(null);

  const add = async (issue: AssignedIssue) => {
    setBusy(issueLabel(issue));

    await withCleanup(
      () => run({ intent: "add-issue", issue: issueLabel(issue) }),
      () => setBusy(null)
    );
  };

  let content: ReactNode;

  if (!work.connected) {
    content = (
      <p className="text-muted p-4 text-base">
        Connect GitHub under{" "}
        <Link
          to="/settings"
          search={{ tab: "tasks" }}
          className="text-accent underline-offset-2 hover:underline"
        >
          Settings → Tasks
        </Link>{" "}
        to see the issues assigned to you here, and to close one when its task
        is done.
      </p>
    );
  } else if (work.issues === null) {
    content = (
      <div className="p-4">
        <Notice tone="error">
          GitHub did not answer. Reload to try again.
        </Notice>
      </div>
    );
  } else if (work.issues.length === 0) {
    content = (
      <p className="text-muted p-4 text-base">
        No open issues are assigned to you.
      </p>
    );
  } else {
    content = (
      <ul className="divide-line divide-y">
        {work.issues.map((issue) => {
          const label = issueLabel(issue);
          const had = inTasks.has(label);

          return (
            <li key={label} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate text-base underline-offset-2 hover:underline"
                >
                  {issue.title}
                </a>
                <div className="text-subtle truncate text-xs">
                  {label}
                  {issue.labels.length > 0 && ` · ${issue.labels.join(", ")}`}
                  {" · "}
                  <Timestamp iso={issue.updatedAt} />
                </div>
              </div>
              {had ? (
                <span className="text-accent inline-flex shrink-0 items-center gap-1 text-xs">
                  <CircleCheck className="h-3.5 w-3.5" />
                  In your tasks
                </span>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    add(issue);
                  }}
                  loading={busy === label}
                >
                  Add to tasks
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return <Section title="Assigned to you on GitHub">{content}</Section>;
};

/** The open tasks by their due day, or the done ones; empty until the reader's own day is known. */
const TaskLists = ({
  view,
  tasks,
  today,
  onOpen,
}: {
  view: TaskView;
  tasks: TaskRow[];
  today: DayKey | null;
  onOpen: (task: TaskRow) => void;
}) => {
  if (!today) {
    return <div aria-busy className="h-24" />;
  }

  if (view === "done") {
    if (!tasks.length) {
      return (
        <Empty
          icon={<SquareCheckBig className="h-4 w-4" />}
          title="Nothing done yet"
        >
          A task you tick off lands here, for a year.
        </Empty>
      );
    }

    return (
      <Section title="Done">
        <ul className="divide-line divide-y">
          {tasks.map((t) => (
            <TaskLine
              key={t.id}
              task={t}
              today={today}
              onOpen={() => onOpen(t)}
            />
          ))}
        </ul>
      </Section>
    );
  }

  const groups = groupTasks(tasks, today);

  if (!groups.length) {
    return (
      <Empty icon={<ListTodo className="h-4 w-4" />} title="No open tasks">
        Add one above, or take one from GitHub below.
      </Empty>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <Section key={g.key} title={g.label}>
          <ul className="divide-line divide-y">
            {g.rows.map((t) => (
              <TaskLine
                key={t.id}
                task={t}
                today={today}
                onOpen={() => onOpen(t)}
              />
            ))}
          </ul>
        </Section>
      ))}
    </>
  );
};

/**
 * Tasks: the open ones by their due day (overdue, today, upcoming, undated) or the done ones, a line to add one
 * quickly, and below them the GitHub issues assigned to the reader, each a press away from being a task. Due days
 * are the reader's, so the list renders once hydrated.
 */
export const TasksPage = ({ data }: { data: TasksData }) => {
  const hydrated = useHydrated();
  const { view, tasks, github } = data;
  const run = useTaskAction();
  const [dialog, setDialog] = useState<{ task: TaskRow | null } | null>(null);
  const [quick, setQuick] = useState("");
  const [adding, setAdding] = useState(false);
  const today = hydrated ? todayKey() : null;

  useShortcuts([{ keys: "n", run: () => setDialog({ task: null }) }]);

  const quickAdd = async (e: FormEvent) => {
    e.preventDefault();

    if (!quick.trim()) {
      return;
    }

    setAdding(true);

    await withCleanup(
      async () => {
        const r = await run(
          { intent: "create", title: quick },
          { quiet: true }
        );

        if (r?.ok) {
          setQuick("");
        }
      },
      () => setAdding(false)
    );
  };

  const byIssue = new Set(
    tasks
      .filter((t) => t.github)
      .map((t) => issueLabel(defined(t.github, "the github")))
  );

  return (
    <>
      <ViewHeader title={TASK_VIEW_LABEL[view]} count={tasks.length}>
        <div className="bg-hover flex items-center gap-0.5 rounded-md p-0.5">
          {TASK_VIEWS.map((v) => (
            <Link
              key={v}
              to="/tasks"
              search={v === "open" ? {} : { view: v }}
              replace
              className={cx(
                "h-6 rounded-[5px] px-2 text-sm leading-6 transition-colors duration-100",
                view === v
                  ? "bg-elevated text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-muted hover:text-fg"
              )}
              aria-current={view === v ? "page" : undefined}
            >
              {TASK_VIEW_LABEL[v]}
            </Link>
          ))}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setDialog({ task: null })}
          title="New task (n)"
        >
          <Plus className="h-3.5 w-3.5" />
          New task
        </Button>
      </ViewHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-4">
          {view === "open" && (
            <form
              onSubmit={(e) => {
                quickAdd(e);
              }}
              className="flex gap-2"
            >
              <input
                name="title"
                className={cx(inputClass, "min-w-0")}
                placeholder="Add a task and press Enter"
                aria-label="New task"
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                autoComplete="off"
              />
              <Button type="submit" loading={adding} disabled={!quick.trim()}>
                Add
              </Button>
            </form>
          )}
          <TaskLists
            view={view}
            tasks={tasks}
            today={today}
            onOpen={(task) => setDialog({ task })}
          />
          <GitHubSection work={github} inTasks={byIssue} />
        </div>
      </div>
      <TaskDialog
        open={dialog !== null}
        task={dialog?.task ?? null}
        today={today ?? "2026-01-01"}
        githubConnected={github.connected}
        onClose={() => setDialog(null)}
      />
    </>
  );
};
