import { ExternalLink, Trash2, Unlink } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { addDays } from "~/lib/calendar/calendar";
import type { DayKey } from "~/lib/calendar/calendar";
import { withCleanup } from "~/lib/cleanup";
import {
  MAX_TASK_NOTES,
  MAX_TASK_TITLE,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  isTaskPriority,
  issueLabel,
} from "~/lib/tasks/tasks";
import type { TaskPriority, TaskRow } from "~/lib/tasks/tasks";

import {
  Button,
  Dialog,
  Field,
  Notice,
  Pill,
  cx,
  inputClass,
  selectClass,
  textareaClass,
} from "../ui";
import { useTaskAction } from "./use-task-action";

interface Form {
  title: string;
  notes: string;
  dueOn: string;
  priority: TaskPriority;
  issue: string;
}

const formOf = (task: TaskRow | null): Form => ({
  title: task?.title ?? "",
  notes: task?.notes ?? "",
  dueOn: task?.dueOn ?? "",
  priority: task?.priority ?? "normal",
  issue: "",
});

/**
 * A task: its title, notes, due day (with the days close by to pick), priority, and the GitHub issue it is linked
 * to, which a new task may name too. Delete is for an existing task.
 */
export const TaskDialog = ({
  open,
  task,
  today,
  githubConnected,
  onClose,
}: {
  open: boolean;
  task: TaskRow | null;
  today: DayKey;
  githubConnected: boolean;
  onClose: () => void;
}) => {
  const run = useTaskAction();
  const [form, setForm] = useState<Form>(() => formOf(task));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new task is saved before its issue is linked. When the link is refused the task exists already, so
  // Save again changes that task and links it, rather than making a second one.
  const [made, setMade] = useState<string | null>(null);

  // Opening the dialog, or opening it on another task, starts the form over: adjusted while rendering, since
  // an effect would paint the previous task's form first.
  const [shown, setShown] = useState({ open, task });

  if (shown.open !== open || shown.task !== task) {
    setShown({ open, task });

    if (open) {
      setForm(formOf(task));
      setError(null);
      setMade(null);
    }
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();

    if (!form.title.trim()) {
      setError("A task needs a title.");

      return;
    }

    setBusy(true);
    setError(null);

    await withCleanup(
      async () => {
        const id = task?.id ?? made;

        const r = await run({
          intent: id ? "update" : "create",
          id: id ?? "",
          title: form.title,
          notes: form.notes,
          dueOn: form.dueOn,
          priority: form.priority,
        });

        if (!r?.ok) {
          if (r && !r.ok) {
            setError(r.error);
          }

          return;
        }

        if (!task && r.task) {
          setMade(r.task.id);
        }

        // A new task that names an issue is linked to it once it exists.
        if (form.issue.trim() && r.task) {
          const linked = await run(
            { intent: "link", id: r.task.id, issue: form.issue },
            { quiet: true }
          );

          if (linked && !linked.ok) {
            setError(
              `${linked.error} The task is saved; fix the issue and press Save to link it.`
            );

            return;
          }
        }

        onClose();
      },
      () => setBusy(false)
    );
  };

  const link = async (issue: string) => {
    if (!task) {
      return;
    }

    setBusy(true);
    setError(null);

    await withCleanup(
      async () => {
        const r = await run({ intent: "link", id: task.id, issue });

        if (r && !r.ok) {
          setError(r.error);
        } else {
          set("issue", "");
        }
      },
      () => setBusy(false)
    );
  };

  const remove = async () => {
    // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
    if (!task || !confirm("Delete this task?")) {
      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        const r = await run({ intent: "delete", id: task.id });

        if (r?.ok) {
          onClose();
        }
      },
      () => setBusy(false)
    );
  };

  const quick: [string, string][] = [
    ["Today", today],
    ["Tomorrow", addDays(today, 1)],
    ["Next week", addDays(today, 7)],
    ["No day", ""],
  ];

  const linkSection = task?.github ? (
    <div className="flex items-center gap-2 text-base">
      <Pill tone={task.github.state === "closed" ? "neutral" : "accent"}>
        GitHub
      </Pill>
      <a
        href={task.github.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent inline-flex min-w-0 items-center gap-1 truncate underline-offset-2 hover:underline"
      >
        {issueLabel(task.github)}
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
      {task.github.state === "closed" && (
        <span className="text-subtle">closed</span>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void link("");
        }}
        disabled={busy}
        className="ml-auto"
      >
        <Unlink className="h-3.5 w-3.5" />
        Unlink
      </Button>
    </div>
  ) : (
    <Field
      label="GitHub issue"
      hint={
        githubConnected
          ? "owner/name#123, or the issue's address. Marking the task done closes the issue."
          : "Connect GitHub under Settings → Tasks to link an issue."
      }
    >
      <div className="flex gap-1.5">
        <input
          name="issue"
          className={cx(inputClass, "min-w-0")}
          value={form.issue}
          onChange={(e) => set("issue", e.target.value)}
          placeholder="owner/repo#123"
          autoComplete="off"
          disabled={!githubConnected}
        />
        {task && (
          <Button
            onClick={() => {
              void link(form.issue);
            }}
            disabled={busy || !form.issue.trim()}
          >
            Link
          </Button>
        )}
      </div>
    </Field>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={task ? "Edit task" : "New task"}
    >
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
        className="space-y-3"
      >
        <Field label="Title">
          <input
            name="title"
            className={inputClass}
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            maxLength={MAX_TASK_TITLE}
            autoComplete="off"
            autoFocus
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due">
            <input
              type="date"
              name="dueOn"
              className={inputClass}
              value={form.dueOn}
              onChange={(e) => set("dueOn", e.target.value)}
            />
            <div className="mt-1 flex flex-wrap gap-1">
              {quick.map(([label, day]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => set("dueOn", day)}
                  className={cx(
                    "rounded-[4px] px-1.5 text-xs transition-colors",
                    form.dueOn === day
                      ? "bg-accent-soft text-accent"
                      : "text-muted hover:bg-hover hover:text-fg"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Priority">
            <select
              name="priority"
              className={cx(selectClass, "w-full")}
              value={form.priority}
              onChange={(e) => {
                const next = e.target.value;

                if (isTaskPriority(next)) {
                  set("priority", next);
                }
              }}
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            name="notes"
            className={textareaClass}
            rows={3}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            maxLength={MAX_TASK_NOTES}
          />
        </Field>
        {linkSection}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex items-center gap-2">
          {task && (
            <Button
              variant="ghost"
              onClick={() => {
                void remove();
              }}
              disabled={busy}
              className="text-red"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              {task ? "Save" : "Add"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
};
