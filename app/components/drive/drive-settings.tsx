import { KeyRound, Link2, Mail } from "lucide-react";
import { useId } from "react";

import { useAction } from "~/lib/action";
import { driveAdminAction } from "~/lib/drive/actions";
import type { ExternalShareRecord } from "~/lib/drive/links.server";

import { Button, Checkbox, Notice, Pill, Section, Timestamp } from "../ui";

/** Whether a link or invite still works, and if not, how it ended. */
const LinkStatus = ({ record }: { record: ExternalShareRecord }) => {
  if (record.live) {
    return <Pill tone="accent">Live</Pill>;
  }

  return <Pill>{record.revokedAt ? "Stopped" : "Ended"}</Pill>;
};

/** How a link or invite ended or when it will: stopped by someone, its end date, or no end. */
const LinkEnding = ({ record }: { record: ExternalShareRecord }) => {
  if (record.revokedAt) {
    return (
      <>
        {" · stopped by "}
        {record.revokedBy} <Timestamp iso={record.revokedAt} relative={false} />
      </>
    );
  }

  if (record.expiresAt) {
    return (
      <>
        {record.live ? " · until " : " · ended "}
        <Timestamp iso={record.expiresAt} relative={false} />
      </>
    );
  }

  return " · no end date";
};

/**
 * Settings → Drive, for an admin (#2836): the switch for sharing outside the workspace, and the record of every link
 * and invite: what it shared, who made it and who stopped it, and how often it was opened.
 */
export const DriveSettings = ({
  sharing,
  records,
}: {
  sharing: { on: boolean; updatedBy: string | null; updatedAt: string | null };
  records: ExternalShareRecord[];
}) => {
  const act = useAction(driveAdminAction);
  const hint = useId();

  return (
    <>
      <Section title="Sharing outside the workspace">
        <act.Form className="space-y-3 p-4">
          <div>
            <label className="text-fg flex items-center gap-2.5 text-base">
              <Checkbox
                name="on"
                defaultChecked={sharing.on}
                aria-describedby={hint}
              />
              Let people share files and folders outside the workspace
            </label>
            <p id={hint} className="text-muted mt-1 pl-6 text-sm">
              Anyone who reaches a file or folder can make a link to it, or
              invite an address, to view and download it. Turned off, nobody
              makes a new one and every existing link and invitation stops
              working; nothing is deleted, so turning it on again brings them
              back.
              {sharing.updatedAt && (
                <>
                  {" "}
                  Last changed by {sharing.updatedBy ?? "an admin"},{" "}
                  <Timestamp iso={sharing.updatedAt} relative={false} />.
                </>
              )}
            </p>
          </div>
          {(act.data?.error ?? act.error) && (
            <Notice tone="error">{act.data?.error ?? act.error}</Notice>
          )}
          {act.data?.message && (
            <Notice tone="success">{act.data.message}</Notice>
          )}
          <Button
            type="submit"
            name="intent"
            value="external-sharing"
            variant="primary"
            loading={act.state === "submitting"}
          >
            Save
          </Button>
        </act.Form>
      </Section>
      <Section title="Links and invitations">
        {records.length ? (
          <ul className="divide-line divide-y">
            {records.map((r) => (
              <li key={r.id} className="space-y-0.5 px-4 py-2 text-base">
                <div className="flex min-w-0 items-center gap-1.5">
                  {r.kind === "invite" ? (
                    <Mail className="text-subtle h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <Link2 className="text-subtle h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 truncate font-medium">
                    {r.node.name}
                  </span>
                  <span className="text-muted min-w-0 truncate">
                    {r.kind === "invite"
                      ? `to ${r.email}`
                      : "to anyone with the link"}
                  </span>
                  {r.password && (
                    <KeyRound
                      className="text-subtle h-3 w-3 shrink-0"
                      aria-label="Password"
                    />
                  )}
                  <span className="ml-auto shrink-0">
                    <LinkStatus record={r} />
                  </span>
                </div>
                <div className="text-subtle text-sm">
                  By {r.createdBy.name} ({r.createdBy.email}){" "}
                  <Timestamp iso={r.createdAt} relative={false} />
                  <LinkEnding record={r} />
                  {` · ${r.views} ${r.views === 1 ? "view" : "views"}, ${r.downloads} ${r.downloads === 1 ? "download" : "downloads"}`}
                  {!r.allowDownload && " · no downloads"}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted p-4 text-base">
            Nothing has been shared outside yet.
          </p>
        )}
      </Section>
    </>
  );
};
