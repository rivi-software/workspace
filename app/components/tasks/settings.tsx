import { Unplug } from "lucide-react";

import { useAction } from "~/lib/action";
import { githubAction } from "~/lib/tasks/actions";
import type { GitHubConnectionView } from "~/lib/tasks/github.server";

import {
  Button,
  Field,
  Notice,
  Pill,
  Section,
  Timestamp,
  inputClass,
} from "../ui";

/**
 * Settings → Tasks (#3111): the person's own GitHub connection, a personal access token pasted once and kept sealed,
 * which the Tasks page reads their assigned issues with and closes an issue through when its task is done.
 */
export const TasksSettings = ({
  github,
}: {
  github: GitHubConnectionView | null;
}) => {
  const act = useAction(githubAction);

  return (
    <Section title="GitHub">
      <act.Form className="space-y-3 p-4">
        {github ? (
          <>
            <div className="flex items-center gap-2 text-base">
              <span className="font-medium">{github.name ?? github.login}</span>
              <span className="text-muted">@{github.login}</span>
              <Pill tone="accent">Connected</Pill>
              <span className="text-subtle ml-auto text-xs">
                since <Timestamp iso={github.connectedAt} relative={false} />
              </span>
            </div>
            <p className="text-muted text-base">
              The Tasks page lists the open issues assigned to this account. A
              task made from an issue, or linked to one, closes the issue when
              you mark it done and reopens it when you reopen the task.
              Disconnecting deletes the token; your tasks stay.
            </p>
          </>
        ) : (
          <>
            <p className="text-muted text-base">
              Paste a personal access token of your own to see the GitHub issues
              assigned to you on the Tasks page and to close one by ticking its
              task off. A fine-grained token with{" "}
              <strong>Issues: read and write</strong> on the repositories you
              work in (and <strong>Metadata: read-only</strong>, which GitHub
              adds itself) is enough. The token is kept encrypted and never
              shown again.
            </p>
            <Field label="Personal access token">
              <input
                name="token"
                type="password"
                className={inputClass}
                placeholder="github_pat_…"
                autoComplete="off"
                required
              />
            </Field>
          </>
        )}
        {(act.data?.error ?? act.error) && (
          <Notice tone="error">{act.data?.error ?? act.error}</Notice>
        )}
        {act.data?.message && (
          <Notice tone="success">{act.data.message}</Notice>
        )}
        <div className="flex gap-2">
          {github ? (
            <Button
              type="submit"
              name="intent"
              value="disconnect"
              loading={act.state === "submitting"}
              onClick={(e) => {
                // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                if (!confirm("Disconnect GitHub? The token is deleted.")) {
                  e.preventDefault();
                }
              }}
            >
              <Unplug className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          ) : (
            <Button
              type="submit"
              name="intent"
              value="connect"
              variant="primary"
              loading={act.state === "submitting"}
            >
              Connect GitHub
            </Button>
          )}
        </div>
      </act.Form>
    </Section>
  );
};
