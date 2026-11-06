import { useServerFn } from "@tanstack/react-start";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  Globe,
  HardDrive,
  KeyRound,
  Link2,
  Loader2,
  Mail,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { useAction } from "~/lib/action";
import { withCleanup } from "~/lib/cleanup";
import {
  driveAction,
  driveMoveTargets,
  driveSharing,
} from "~/lib/drive/actions";
import type { MoveTargetsResult, SharingResult } from "~/lib/drive/actions";
import {
  DRIVE_ROLE_LABEL,
  DRIVE_SHARE_ROLES,
  EVERYONE,
  LINK_DEFAULT_DAYS,
  LINK_PASSWORD_MIN,
  MAX_NODE_NAME,
  isShareRole,
  splitExtension,
} from "~/lib/drive/drive";
import type { DriveShareRole } from "~/lib/drive/drive";
import type { FolderOption } from "~/lib/drive/drive.server";
import type {
  ExternalShareView,
  ExternalSharing,
} from "~/lib/drive/links.server";

import { useToast } from "../toast";
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Notice,
  Pill,
  Timestamp,
  cx,
  inputClass,
  selectClass,
} from "../ui";
import { useDriveAction } from "./use-drive-action";

/* ---------- a name: a new folder, or a rename ---------- */

export const NameDialog = ({
  open,
  title,
  initial = "",
  submitLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<boolean>;
  onClose: () => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      return;
    }

    const el = input.current;

    if (!el) {
      return;
    }

    el.value = initial;
    // The name without its extension is what a rename usually changes.
    const [base] = splitExtension(initial);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(0, base.length || initial.length);
    });
  }, [open, initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = input.current?.value.trim() ?? "";

    if (!name) {
      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        if (await onSubmit(name)) {
          onClose();
        }
      },
      () => setBusy(false)
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        onSubmit={(e) => {
          submit(e);
        }}
        className="space-y-3"
      >
        <Field label="Name">
          <input
            ref={input}
            name="name"
            className={inputClass}
            maxLength={MAX_NODE_NAME}
            autoComplete="off"
            required
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/* ---------- where to move something ---------- */

/**
 * The folders a move could go to, as a tree the person opens level by level; what is being moved, and everything
 * under it, cannot be chosen. The root of their own drive is a choice for their own things.
 */
export const MoveDialog = ({
  open,
  ids,
  currentId,
  onClose,
  onMoved,
}: {
  open: boolean;
  ids: string[];
  /** The folder the things are in now (null at the root), chosen first. */
  currentId: string | null;
  onClose: () => void;
  onMoved?: () => void;
}) => {
  const fetchTargets = useServerFn(driveMoveTargets);
  const run = useDriveAction();
  const [targets, setTargets] = useState<MoveTargetsResult | null>(null);
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const key = ids.join(",");

  useEffect(() => {
    if (!open) {
      return;
    }

    // Aborted once the dialog closes or its selection changes, so a late answer is not shown.
    const reading = new AbortController();

    const readTargets = async () => {
      setTargets(null);
      setChosen(undefined);

      const r = await fetchTargets({
        data: { ids: key.split(",").filter(Boolean) },
      });

      if (reading.signal.aborted) {
        return;
      }

      setTargets(r);

      if (!r.ok) {
        return;
      }

      // Start open down to the current folder.
      const byId = new Map(r.folders.map((f) => [f.id, f]));
      const openIds = new Set<string>();
      let cursor = currentId ? byId.get(currentId) : undefined;

      while (cursor) {
        openIds.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }

      setExpanded(openIds);
      setChosen(currentId ?? (r.root ? null : undefined));
    };

    readTargets();

    return () => reading.abort();
  }, [open, key, currentId, fetchTargets]);

  const tree = useMemo(() => {
    if (!targets?.ok) {
      return null;
    }

    const children = new Map<string | null, FolderOption[]>();

    for (const f of targets.folders) {
      const list = children.get(f.parentId) ?? [];
      list.push(f);
      children.set(f.parentId, list);
    }

    // The things being moved, with their subtrees: not a destination.
    const blocked = new Set<string>();

    const walk = (id: string) => {
      if (blocked.has(id)) {
        return;
      }

      blocked.add(id);

      for (const c of children.get(id) ?? []) {
        walk(c.id);
      }
    };

    for (const id of key.split(",")) {
      if (id) {
        walk(id);
      }
    }

    return { children, blocked, root: targets.root };
  }, [targets, key]);

  const move = async () => {
    if (chosen === undefined) {
      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        const r = await run({
          intent: "move",
          ids: JSON.stringify(key.split(",").filter(Boolean)),
          target: chosen ?? "",
        });

        if (r?.ok) {
          onMoved?.();
          onClose();
        }
      },
      () => setBusy(false)
    );
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });

  const renderLevel = (parentId: string | null, depth: number) =>
    (tree?.children.get(parentId) ?? []).map((f) => {
      const kids = tree?.children.get(f.id) ?? [];
      const blocked = tree?.blocked.has(f.id) ?? false;
      const isOpen = expanded.has(f.id);

      return (
        <li key={f.id}>
          <div
            className={cx(
              "flex h-7 items-center gap-1 rounded-md pr-2 text-base",
              chosen === f.id ? "bg-selected text-fg" : "hover:bg-hover",
              blocked && "opacity-40"
            )}
            style={{ paddingLeft: 4 + depth * 16 }}
          >
            <button
              type="button"
              className={cx(
                "flex h-5 w-5 items-center justify-center rounded-sm text-subtle",
                !kids.length && "invisible"
              )}
              onClick={() => toggle(f.id)}
              aria-label={isOpen ? `Collapse ${f.name}` : `Expand ${f.name}`}
              tabIndex={-1}
            >
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => setChosen(f.id)}
              onDoubleClick={() => kids.length && toggle(f.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
              aria-pressed={chosen === f.id}
            >
              <Folder className="text-muted h-4 w-4 shrink-0" />
              <span className="truncate">{f.name}</span>
            </button>
          </div>
          {isOpen && kids.length > 0 && <ul>{renderLevel(f.id, depth + 1)}</ul>}
        </li>
      );
    });

  let body: ReactNode;

  if (!targets) {
    body = (
      <div className="text-subtle flex h-24 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  } else if (targets.ok) {
    body = (
      <>
        <ul
          className="border-line max-h-72 overflow-y-auto rounded-md border p-1"
          aria-label="Folders"
        >
          {tree?.root && (
            <li>
              <button
                type="button"
                onClick={() => setChosen(null)}
                aria-pressed={chosen === null}
                className={cx(
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-base",
                  chosen === null ? "bg-selected text-fg" : "hover:bg-hover"
                )}
              >
                <HardDrive className="text-muted h-4 w-4 shrink-0" />
                My Drive
              </button>
            </li>
          )}
          {renderLevel(null, tree?.root ? 1 : 0)}
          {!targets.folders.length && !tree?.root && (
            <li className="text-subtle px-2 py-3 text-sm">
              Nowhere else to put this.
            </li>
          )}
        </ul>
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={chosen === undefined}
            onClick={() => {
              move();
            }}
          >
            Move here
          </Button>
        </div>
      </>
    );
  } else {
    body = <Notice tone="error">{targets.error}</Notice>;
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Move ${ids.length === 1 ? "to" : `${ids.length} items to`}`}
    >
      {body}
    </Dialog>
  );
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** yyyy-mm-dd, `days` from today in the reader's time zone: what a date input holds. */
const dateInputValue = (days: number): string => {
  const d = new Date(Date.now() + days * 86_400_000);

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The end of a chosen day in the reader's time zone, as the server keeps it. */
const endOfDay = (value: string): string =>
  new Date(`${value}T23:59:59`).toISOString();

const useCopyLink = () => {
  const toast = useToast();

  return (url: string) =>
    navigator.clipboard.writeText(url).then(
      () => toast.show({ message: "Link copied." }),
      () =>
        toast.show({ message: "The link could not be copied.", tone: "error" })
    );
};

export const CopyLinkButton = ({ url }: { url: string }) => {
  const copy = useCopyLink();

  return (
    <IconButton
      size="sm"
      label="Copy link"
      onClick={() => {
        copy(url);
      }}
    >
      <Copy className="h-3.5 w-3.5" />
    </IconButton>
  );
};

/** What a link or invite is, in a few words: who it is for and what it allows. */
const ExternalLabel = ({ link }: { link: ExternalShareView }) => (
  <span className="flex min-w-0 items-center gap-1.5">
    {link.kind === "invite" ? (
      <Mail className="text-subtle h-3.5 w-3.5 shrink-0" />
    ) : (
      <Link2 className="text-subtle h-3.5 w-3.5 shrink-0" />
    )}
    <span className="truncate">
      {link.kind === "invite" ? link.email : "Anyone with the link"}
    </span>
    {link.password && (
      <KeyRound
        className="text-subtle h-3 w-3 shrink-0"
        aria-label="Password"
      />
    )}
    {!link.allowDownload && <Pill className="shrink-0">No downloads</Pill>}
  </span>
);

/** Whether a link still stands, when it ends, or who stopped it and when. */
const ExternalEnd = ({ link }: { link: ExternalShareView }) => {
  if (link.live) {
    return link.expiresAt ? (
      <>
        Until <Timestamp iso={link.expiresAt} relative={false} />
      </>
    ) : (
      "No end date"
    );
  }

  if (link.revokedAt) {
    return (
      <>
        Stopped by {link.revokedBy} <Timestamp iso={link.revokedAt} />
      </>
    );
  }

  return (
    <>
      Ended <Timestamp iso={link.expiresAt ?? link.createdAt} />
    </>
  );
};

/** When it ends, how often it was used and who made it. */
const ExternalMeta = ({ link }: { link: ExternalShareView }) => (
  <span className="text-subtle text-xs">
    <ExternalEnd link={link} />
    {" · "}
    {link.views} {link.views === 1 ? "view" : "views"} · {link.downloads}{" "}
    {link.downloads === 1 ? "download" : "downloads"}
    {link.kind === "invite" &&
      !link.confirmedAt &&
      link.live &&
      " · not opened yet"}
    {" · by "}
    {link.mine ? "you" : link.createdBy.name}
  </span>
);

/**
 * Links and invites outside the workspace: the live ones with their address to copy and a way to stop them, a form
 * for a new one, and the ended ones on record.
 */
const ExternalSection = ({
  node,
  external,
  onChanged,
}: {
  node: { id: string; name: string; kind: "folder" | "file" };
  external: ExternalSharing;
  onChanged: () => void;
}) => {
  const run = useDriveAction();
  const toast = useToast();
  const copy = useCopyLink();
  const [kind, setKind] = useState<"link" | "invite">("link");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ends, setEnds] = useState(() => dateInputValue(LINK_DEFAULT_DAYS));
  const [never, setNever] = useState(false);
  const [downloads, setDownloads] = useState(true);
  const [busy, setBusy] = useState(false);
  const live = external.links.filter((l) => l.live);
  const ended = external.links.filter((l) => !l.live);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);

    await withCleanup(
      async () => {
        const r = await run(
          {
            intent: "link",
            id: node.id,
            kind,
            email: kind === "invite" ? email : "",
            password: kind === "link" ? password : "",
            downloads: downloads ? "1" : "0",
            expires: never ? "never" : endOfDay(ends),
          },
          { quiet: true }
        );

        if (!r?.ok) {
          return;
        }

        if (kind === "link" && r.url) {
          await copy(r.url);
        } else {
          toast.show({ message: `Invitation sent to ${email}.` });
        }

        setEmail("");
        setPassword("");
        onChanged();
      },
      () => setBusy(false)
    );
  };

  const revoke = async (link: ExternalShareView) => {
    const r = await run(
      { intent: "revoke-link", link: link.id },
      { quiet: true }
    );

    if (r?.ok) {
      onChanged();
    }
  };

  return (
    <div className="border-line space-y-3 border-t pt-4">
      <div>
        <div className="text-fg text-sm font-medium">
          Share outside the workspace
        </div>
        <p className="text-subtle text-xs">
          To view{node.kind === "folder" ? " everything in it" : ""}, never to
          change. A link stops when you stop it, when it ends, or when you lose
          access yourself.
        </p>
      </div>
      {!external.enabled && (
        <Notice>
          An admin turned off sharing outside the workspace. Links and invites
          made before stay off until it is on again.
        </Notice>
      )}
      {live.length > 0 && (
        <ul
          className="divide-line border-line divide-y rounded-md border"
          aria-label="Live links"
        >
          {live.map((l) => (
            <li
              key={l.id}
              className="flex items-center gap-2 px-3 py-1.5 text-base"
            >
              <span className="min-w-0 flex-1">
                <ExternalLabel link={l} />
                <ExternalMeta link={l} />
              </span>
              {l.url && <CopyLinkButton url={l.url} />}
              {l.canRevoke && (
                <IconButton
                  size="sm"
                  label={
                    l.kind === "invite"
                      ? `Stop the invitation to ${l.email}`
                      : "Stop link"
                  }
                  onClick={() => {
                    revoke(l);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {external.canCreate && (
        <form
          onSubmit={(e) => {
            create(e);
          }}
          className="border-line space-y-3 rounded-md border p-3"
        >
          <div className="flex items-end gap-2">
            <Field label="Who" className="shrink-0">
              <select
                value={kind}
                onChange={(e) =>
                  setKind(
                    e.currentTarget.value === "invite" ? "invite" : "link"
                  )
                }
                className={selectClass}
              >
                <option value="link">Anyone with the link</option>
                <option value="invite">Someone by email</option>
              </select>
            </Field>
            {kind === "invite" ? (
              <Field label="Email" className="min-w-0 flex-1">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  className={inputClass}
                  placeholder="name@example.com"
                  autoComplete="off"
                  required
                />
              </Field>
            ) : (
              <Field label="Password (optional)" className="min-w-0 flex-1">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  className={inputClass}
                  minLength={LINK_PASSWORD_MIN}
                  autoComplete="new-password"
                />
              </Field>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="text-muted flex items-center gap-2 text-sm">
              Ends
              <input
                type="date"
                value={ends}
                min={dateInputValue(1)}
                onChange={(e) => setEnds(e.currentTarget.value)}
                disabled={never}
                required={!never}
                className={cx(inputClass, "h-7 w-auto")}
              />
            </label>
            <label className="text-muted flex items-center gap-2 text-sm">
              <Checkbox
                checked={never}
                onChange={(e) => setNever(e.currentTarget.checked)}
              />
              No end date
            </label>
            <label className="text-muted flex items-center gap-2 text-sm">
              <Checkbox
                checked={downloads}
                onChange={(e) => setDownloads(e.currentTarget.checked)}
              />
              Allow downloads
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy}>
              {kind === "invite" ? "Send invitation" : "Create and copy link"}
            </Button>
          </div>
        </form>
      )}
      {ended.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted cursor-default">
            Ended ({ended.length})
          </summary>
          <ul className="divide-line border-line mt-2 divide-y rounded-md border">
            {ended.map((l) => (
              <li key={l.id} className="px-3 py-1.5 text-base opacity-80">
                <ExternalLabel link={l} />
                <ExternalMeta link={l} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

/* ---------- who a node is shared with ---------- */

/**
 * Who a node is shared with. Inside the workspace (its owner only): colleagues or everyone, as viewers or editors.
 * Outside (everyone who reaches it): links and invites, viewer only.
 */
export const ShareDialog = ({
  open,
  node,
  onClose,
}: {
  open: boolean;
  node: { id: string; name: string; kind: "folder" | "file" } | null;
  onClose: () => void;
}) => {
  const fetchSharing = useServerFn(driveSharing);
  const run = useDriveAction();
  const [data, setData] = useState<SharingResult | null>(null);
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<DriveShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const id = node?.id ?? "";

  const refresh = async () => {
    if (!id) {
      return;
    }

    setData(await fetchSharing({ data: { id } }));
  };

  useEffect(() => {
    if (!open || !id) {
      return;
    }

    let live = true;

    const readSharing = async () => {
      setData(null);
      setSubject("");
      setRole("viewer");

      const r = await fetchSharing({ data: { id } });

      if (live) {
        setData(r);
      }
    };

    readSharing();

    return () => {
      live = false;
    };
  }, [open, id, fetchSharing]);

  const shared = data?.ok ? data.shares : [];

  const people = data?.ok
    ? data.people.filter((p) => !shared.some((s) => s.subject === p.id))
    : [];

  const everyoneShared = shared.some((s) => s.subject === EVERYONE);

  const add = async (e: FormEvent) => {
    e.preventDefault();

    if (!subject) {
      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        const r = await run(
          { intent: "share", id, subject, role },
          { quiet: true }
        );

        if (r?.ok) {
          setSubject("");
          await refresh();
        }
      },
      () => setBusy(false)
    );
  };

  const change = async (s: string, r: DriveShareRole) => {
    await run({ intent: "share", id, subject: s, role: r }, { quiet: true });
    await refresh();
  };

  const remove = async (s: string) => {
    await run({ intent: "unshare", id, subject: s }, { quiet: true });
    await refresh();
  };

  let body: ReactNode;

  if (!data) {
    body = (
      <div className="text-subtle flex h-24 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  } else if (data.ok) {
    body = (
      <div className="space-y-5">
        {data.external.owner ? (
          <div className="space-y-4">
            <form
              onSubmit={(e) => {
                add(e);
              }}
              className="flex items-end gap-2"
            >
              <Field label="Share with" className="min-w-0 flex-1">
                <select
                  name="subject"
                  value={subject}
                  onChange={(e) => setSubject(e.currentTarget.value)}
                  className={cx(selectClass, "w-full")}
                >
                  <option value="">Choose…</option>
                  {!everyoneShared && (
                    <option value={EVERYONE}>Everyone in the workspace</option>
                  )}
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.email})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Role">
                <select
                  name="role"
                  value={role}
                  onChange={(e) => {
                    const next = e.currentTarget.value;

                    if (isShareRole(next)) {
                      setRole(next);
                    }
                  }}
                  className={selectClass}
                >
                  {DRIVE_SHARE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {DRIVE_ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={!subject}
              >
                Share
              </Button>
            </form>
            <div>
              <div className="text-muted mb-1 text-sm font-medium">
                Who has access
              </div>
              <ul className="divide-line border-line divide-y rounded-md border">
                <li className="flex h-9 items-center gap-2 px-3 text-base">
                  <Avatar name="You" size={20} />
                  <span className="flex-1">You</span>
                  <span className="text-subtle text-sm">Owner</span>
                </li>
                {shared.map((s) => (
                  <li
                    key={s.id}
                    className="flex h-9 items-center gap-2 px-3 text-base"
                  >
                    {s.person ? (
                      <Avatar name={s.person.name} size={20} />
                    ) : (
                      <span className="text-subtle flex h-5 w-5 items-center justify-center">
                        <Globe className="h-4 w-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {s.person ? (
                        <>
                          {s.person.name}{" "}
                          <span className="text-subtle">{s.person.email}</span>
                        </>
                      ) : (
                        "Everyone in the workspace"
                      )}
                    </span>
                    <select
                      aria-label={`Role of ${s.person?.name ?? "everyone"}`}
                      value={s.role}
                      onChange={(e) => {
                        const next = e.currentTarget.value;

                        if (isShareRole(next)) {
                          change(s.subject, next);
                        }
                      }}
                      className={cx(selectClass, "h-6 text-sm")}
                    >
                      {DRIVE_SHARE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {DRIVE_ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        remove(s.subject);
                      }}
                      className="text-subtle hover:text-fg rounded-sm p-0.5"
                      aria-label={`Stop sharing with ${s.person?.name ?? "everyone"}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              {node?.kind === "folder" && (
                <p className="text-subtle mt-2 text-xs">
                  Sharing a folder shares everything in it. Editors can add,
                  rename, move and trash within it.
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-muted text-sm">
            Only its owner shares it inside the workspace. You can share it
            outside, to view.
          </p>
        )}
        {node && (
          <ExternalSection
            node={node}
            external={data.external}
            onChanged={() => {
              refresh();
            }}
          />
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  } else {
    body = <Notice tone="error">{data.error}</Notice>;
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={node ? `Share "${node.name}"` : "Share"}
    >
      {body}
    </Dialog>
  );
};

/* ---------- outside the workspace ---------- */

const OutsideRow = ({ link }: { link: ExternalShareView }) => {
  const revoke = useAction(driveAction, { link: link.id });

  return (
    <li className="flex items-center gap-1">
      <span className="min-w-0 flex-1">
        <ExternalLabel link={link} />
        {link.url && (
          <a
            href={link.url}
            className="text-subtle block truncate text-xs"
            rel="noreferrer"
          >
            {link.url}
          </a>
        )}
      </span>
      {link.url && <CopyLinkButton url={link.url} />}
      {link.canRevoke && (
        <revoke.Form>
          <IconButton
            type="submit"
            name="intent"
            value="revoke-link"
            size="sm"
            label="Stop link"
            disabled={revoke.state === "submitting"}
          >
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </revoke.Form>
      )}
    </li>
  );
};

/**
 * The file page's "Outside the workspace": its live links and invites, each to copy or stop, a link made at once with
 * the defaults (`LINK_DEFAULT_DAYS`, downloads allowed), and the share dialog for the rest. Plain forms through
 * `driveAction`, so they work before the page's script runs.
 */
export const OutsideDetail = ({
  nodeId,
  external,
  onManage,
}: {
  nodeId: string;
  external: ExternalSharing;
  onManage?: () => void;
}) => {
  const create = useAction(driveAction, { id: nodeId });
  const live = external.links.filter((l) => l.live);

  const failed =
    create.data && !create.data.ok ? create.data.error : create.error;

  if (!external.enabled) {
    return <span className="text-subtle">Turned off by an admin</span>;
  }

  return (
    <div className="space-y-1.5">
      {live.length ? (
        <ul className="space-y-1">
          {live.map((l) => (
            <OutsideRow key={l.id} link={l} />
          ))}
        </ul>
      ) : (
        <span>Not shared outside</span>
      )}
      {failed && <p className="text-red text-xs">{failed}</p>}
      <div className="flex items-center gap-3">
        {external.canCreate && (
          <create.Form>
            <button
              type="submit"
              name="intent"
              value="link"
              disabled={create.state === "submitting"}
              className="text-accent hover:underline disabled:opacity-50"
            >
              Create link
            </button>
          </create.Form>
        )}
        {onManage && (
          <button
            type="button"
            onClick={onManage}
            className="text-accent hover:underline"
          >
            Manage
          </button>
        )}
      </div>
    </div>
  );
};
