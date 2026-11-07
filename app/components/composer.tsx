import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  CalendarClock,
  ExternalLink,
  Lock,
  LockOpen,
  Paperclip,
  Send,
  Signature,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { withCleanup } from "~/lib/cleanup";
import { defined } from "~/lib/guards";
import {
  draftAction,
  scheduleAction,
  sendAction,
  unscheduleAction,
} from "~/lib/mail/actions";
import type {
  ComposeData,
  DraftFileView,
  Prefill,
} from "~/lib/mail/compose.server";
import { pgpRecipientsAction } from "~/lib/mail/pgp/actions";
import { sendLaterPresets, snoozeLabel } from "~/lib/mail/snooze";
import { formatBytes } from "~/lib/text";

import { AddressField } from "./address-field";
import { SignaturePreview } from "./message-body";
import { RichEditor } from "./rich-editor";
import type { RichEditorHandle } from "./rich-editor";
import { SnoozeMenu } from "./snooze-menu";
import { useToast } from "./toast";
import { Button, IconButton, Notice, cx, inputClass, selectClass } from "./ui";

const AUTOSAVE_MS = 2000;
const MAX_TOTAL = 20 * 1024 * 1024;

/** The list's own search params, kept across the composer and the thread (folder, search, page, label). */
export const listSearch = (prev: Record<string, string | undefined>) => {
  const out: Record<string, string> = {};

  for (const key of ["folder", "q", "page", "label"]) {
    if (prev[key]) {
      out[key] = defined(prev[key], "the item");
    }
  }

  return out;
};

const keepList = (prev: Record<string, string | undefined>) => listSearch(prev);

const titleOf = (mode: Prefill["mode"]): string => {
  if (mode === "reply") {
    return "Reply";
  }

  if (mode === "forward") {
    return "Forward";
  }

  return "New message";
};

const draftStatus = (
  saving: boolean,
  dirty: boolean,
  savedAt: string | null
): string => {
  if (saving) {
    return "Saving…";
  }

  return !dirty && savedAt ? "Draft saved" : "";
};

/**
 * A switch that turns once: `take()` answers true the first time only. A held send is settled by Undo, the countdown or
 * the beacon on leaving, and only the first of them may act. It lives outside the component because the React Compiler
 * skips a component that reassigns a local from a callback.
 */
const oneWay = () => {
  let taken = false;

  return {
    take: () => {
      if (taken) {
        return false;
      }

      taken = true;

      return true;
    },
    taken: () => taken,
  };
};

/**
 * The composer's OpenPGP switches: Sign with the owner's key, Encrypt to every recipient's. They post as `pgpSign` and
 * `pgpEncrypt`; while Encrypt is on, the recipients are checked for keys a moment after they change, so the composer
 * names whom it cannot reach before Send refuses.
 */
const PgpSwitches = ({
  initialSign,
  initialEncrypt,
  recipients,
  onChange,
}: {
  initialSign: boolean;
  initialEncrypt: boolean;
  recipients: { to: string; cc: string; bcc: string };
  onChange: () => void;
}) => {
  const checkKeys = useServerFn(pgpRecipientsAction);
  const [sign, setSign] = useState(initialSign);
  const [encrypt, setEncrypt] = useState(initialEncrypt);
  const [unreachable, setUnreachable] = useState<string[]>([]);
  // Only the latest check's answer counts: an earlier one may come back after it.
  const round = useRef(0);
  const { to, cc, bcc } = recipients;

  useEffect(() => {
    if (!encrypt) {
      return;
    }

    const check = async () => {
      round.current += 1;
      const mine = round.current;

      try {
        const result = await checkKeys({ data: { to, cc, bcc } });

        if (mine === round.current) {
          setUnreachable(result.missing);
        }
      } catch {
        // A check that failed says nothing; Send still refuses what it cannot encrypt.
      }
    };

    const timer = setTimeout(check, 400);

    return () => clearTimeout(timer);
  }, [encrypt, to, cc, bcc, checkKeys]);

  return (
    <>
      <input type="hidden" name="pgpSign" value={sign ? "on" : ""} />
      <input type="hidden" name="pgpEncrypt" value={encrypt ? "on" : ""} />
      <span className="flex items-center gap-0.5">
        <IconButton
          label={
            sign ? "Signed with your OpenPGP key" : "Sign with your OpenPGP key"
          }
          active={sign}
          aria-pressed={sign}
          onClick={() => {
            setSign(!sign);
            onChange();
          }}
        >
          <Signature className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={
            encrypt
              ? "Encrypted to every recipient"
              : "Encrypt to every recipient"
          }
          active={encrypt}
          aria-pressed={encrypt}
          onClick={() => {
            setEncrypt(!encrypt);
            onChange();
          }}
        >
          {encrypt ? (
            <Lock className="h-4 w-4" />
          ) : (
            <LockOpen className="h-4 w-4" />
          )}
        </IconButton>
      </span>
      {encrypt && unreachable.length > 0 && (
        <Notice tone="error" className="order-last basis-full">
          There is no OpenPGP key for {unreachable.join(", ")}, so the message
          cannot go encrypted. Switch Encrypt off, or import their key under
          Settings → Mail.
        </Notice>
      )}
    </>
  );
};

/** The fields the composer posts that the person never edits: the conversation it answers, its mode and the plain-text start. */
const ReplyFields = ({ prefill }: { prefill: Prefill }) => (
  <>
    <input type="hidden" name="threadId" value={prefill.threadId ?? ""} />
    <input type="hidden" name="inReplyToId" value={prefill.inReplyToId ?? ""} />
    <input type="hidden" name="mode" value={prefill.mode} />
    <input type="hidden" name="text" value={prefill.text} />
  </>
);

/** The sender: a choice when the person has more than one address, a hidden field otherwise. */
const FromField = ({
  froms,
  from,
  onChange,
}: {
  froms: ComposeData["froms"];
  from: string;
  onChange: () => void;
}) => {
  if (froms.length <= 1) {
    return <input type="hidden" name="from" value={from} />;
  }

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="compose-from"
        className="text-muted w-12 shrink-0 text-sm font-medium"
      >
        From
      </label>
      <select
        id="compose-from"
        name="from"
        defaultValue={from}
        onChange={onChange}
        className={cx(selectClass, "min-w-0 max-w-full")}
      >
        {froms.map((a) => (
          <option key={a.email} value={a.email}>
            {a.name ? `${a.name} <${a.email}>` : a.email}
          </option>
        ))}
      </select>
    </div>
  );
};

/** What goes under the message, as the recipient reads it. */
const SignatureBlock = ({
  signature,
}: {
  signature: ComposeData["signatures"][number] | undefined;
}) => {
  if (!signature) {
    return null;
  }

  if (signature.html) {
    return (
      <div className="border-line border-l-2 pl-2.5">
        <p className="text-muted text-base leading-5">--</p>
        <SignaturePreview html={signature.html} />
      </div>
    );
  }

  return (
    <p className="border-line text-muted border-l-2 pl-2.5 text-base leading-5 whitespace-pre-wrap">
      {`-- \n${signature.text}`}
    </p>
  );
};

/** The files kept on the draft, each with its remove button, and a line while one goes up. */
const AttachmentList = ({
  files,
  uploading,
  onRemove,
}: {
  files: DraftFileView[];
  uploading: boolean;
  onRemove: (file: DraftFileView) => void;
}) => {
  if (files.length === 0 && !uploading) {
    return null;
  }

  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Attachments">
      {files.map((f) => (
        <li
          key={f.id}
          className="border-line bg-bg text-fg inline-flex h-7 items-center gap-1.5 rounded-md border pr-1 pl-2 text-sm"
        >
          <Paperclip className="text-subtle h-3 w-3" />
          <span className="max-w-48 truncate">{f.filename}</span>
          <span className="tnum text-subtle">{formatBytes(f.size)}</span>
          <button
            type="button"
            onClick={() => onRemove(f)}
            aria-label={`Remove ${f.filename}`}
            className="text-subtle hover:text-fg rounded-sm p-0.5"
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
      {uploading && (
        <li className="text-subtle flex h-7 items-center text-sm">
          Uploading…
        </li>
      )}
    </ul>
  );
};

/**
 * The composer, on its own page or inline under a conversation: addresses as chips with suggestions, a rich text
 * area, files kept on the draft as soon as they are chosen, the draft saved by itself while writing, and a send
 * that waits a few seconds so it can be taken back from the toast (Settings → Mail).
 */
export const Composer = ({
  data,
  variant,
  onClose,
  onSent,
  className,
}: {
  data: ComposeData;
  variant: "page" | "inline";
  /** Inline: the box closes (after a send, a discard, or the close button). */
  onClose?: () => void;
  onSent?: (threadId: string) => void;
  className?: string;
}) => {
  const { froms, signatures, prefill, undoSendSeconds, pgp } = data;
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const draft = useServerFn(draftAction);
  const send = useServerFn(sendAction);
  const schedule = useServerFn(scheduleAction);
  const unschedule = useServerFn(unscheduleAction);
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<RichEditorHandle>(null);
  const draftRef = useRef(prefill.draftId);
  const [files, setFiles] = useState<DraftFileView[]>(prefill.files);
  const [uploading, setUploading] = useState(false);
  const [showCc, setShowCc] = useState(!!prefill.cc || !!prefill.bcc);
  const [signatureId, setSignatureId] = useState(prefill.signatureId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // The recipients as typed, for the OpenPGP switches to check for keys while Encrypt is on.
  const [recipients, setRecipients] = useState({
    to: prefill.to,
    cc: prefill.cc,
    bcc: prefill.bcc,
  });

  const [savedAt, setSavedAt] = useState<string | null>(
    prefill.draftId ? "kept" : null
  );

  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gone = useRef(false);
  const signature = signatures.find((s) => s.id === signatureId);

  const title = titleOf(prefill.mode);

  const formData = useCallback((intent: string): FormData => {
    const fd = new FormData(form.current ?? undefined);
    fd.set("intent", intent);
    fd.set("draftId", draftRef.current ?? "");
    fd.delete("files");

    return fd;
  }, []);

  const saveDraft = useCallback(async (): Promise<string | null> => {
    if (gone.current) {
      return draftRef.current;
    }

    setSaving(true);

    return await withCleanup(
      async () => {
        try {
          const result = await draft({ data: formData("save") });

          if (!result.ok) {
            setError(result.error);

            return draftRef.current;
          }

          if (result.draftId) {
            draftRef.current = result.draftId;
          }

          setSavedAt(result.savedAt);
          setDirty(false);

          return result.draftId;
        } catch (saveError) {
          setError(
            saveError instanceof Error ? saveError.message : String(saveError)
          );

          return draftRef.current;
        }
      },
      () => setSaving(false)
    );
  }, [draft, formData]);

  // The draft keeps itself a moment after the last change.
  useEffect(() => {
    if (!dirty) {
      return;
    }

    const timer = setTimeout(() => {
      saveDraft();
    }, AUTOSAVE_MS);

    return () => clearTimeout(timer);
  }, [dirty, saveDraft]);

  // Leaving with a change not yet saved: the draft goes out as a beacon.
  useEffect(() => {
    const onHide = () => {
      if (!dirty || gone.current) {
        return;
      }

      navigator.sendBeacon(draftAction.url, formData("save"));
    };

    window.addEventListener("pagehide", onHide);

    return () => window.removeEventListener("pagehide", onHide);
  }, [dirty, formData]);

  const touch = () => {
    setDirty(true);
    setError(null);
  };

  const uploadFiles = async (chosen: File[]) => {
    const list = chosen.filter((f) => f.size > 0);

    if (!list.length) {
      return;
    }

    const have = files.reduce((n, f) => n + f.size, 0);
    const adding = list.reduce((n, f) => n + f.size, 0);

    if (have + adding > MAX_TOTAL) {
      setError(
        "The attachments are too large: 20 MB is the most a message can carry."
      );

      return;
    }

    setUploading(true);

    await withCleanup(
      async () => {
        try {
          const fd = formData("files");

          for (const f of list) {
            fd.append("files", f);
          }

          const result = await draft({ data: fd });

          if (!result.ok) {
            setError(result.error);

            return;
          }

          if (result.draftId) {
            draftRef.current = result.draftId;
          }

          setFiles(result.files);
          setSavedAt(result.savedAt);
          setDirty(false);
        } catch (uploadError) {
          setError(
            uploadError instanceof Error
              ? uploadError.message
              : String(uploadError)
          );
        }
      },
      () => setUploading(false)
    );
  };

  const removeFile = async (file: DraftFileView) => {
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    const fd = formData("remove-file");
    fd.set("fileId", file.id);
    const result = await draft({ data: fd });

    if (result.ok) {
      setFiles(result.files);
    }
  };

  const leave = (threadId?: string) => {
    gone.current = true;

    if (variant === "inline") {
      onClose?.();

      return;
    }

    if (threadId) {
      navigate({
        to: "/mail/t/$threadId",
        params: { threadId },
        search: keepList,
      });
    } else {
      navigate({
        to: "/mail",
        search: keepList,
      });
    }
  };

  const deliver = async (fd: FormData): Promise<void> => {
    try {
      const result = await send({ data: fd });

      if (result.ok) {
        toast.show({
          message: "Message sent.",
          action: {
            label: "View",
            onClick: () => {
              navigate({
                to: "/mail/t/$threadId",
                params: { threadId: result.threadId },
                search: keepList,
              });
            },
          },
        });
        await router.invalidate();
        onSent?.(result.threadId);
      } else {
        const id = fd.get("draftId");
        toast.show({
          message: result.error,
          tone: "error",
          duration: 0,
          action: id
            ? {
                label: "Open draft",
                onClick: () => {
                  navigate({
                    to: "/mail/compose",
                    search: { draft: String(id) },
                  });
                },
              }
            : undefined,
        });
      }
    } catch (sendError) {
      toast.show({
        message:
          sendError instanceof Error ? sendError.message : String(sendError),
        tone: "error",
        duration: 0,
      });
    }
  };

  const sendNow = async () => {
    if (busy || gone.current) {
      return;
    }

    const fd = formData("send");

    const to =
      `${fd.get("to") ?? ""}${fd.get("cc") ?? ""}${fd.get("bcc") ?? ""}`.trim();

    if (!to) {
      setError("Add at least one recipient.");

      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        if (undoSendSeconds > 0) {
          // The draft is saved first, so Undo has something to come back to.
          const id = await saveDraft();

          if (!id) {
            return;
          }

          fd.set("draftId", id);
          const settled = oneWay();
          toast.show({
            message: `Sending in ${undoSendSeconds} s…`,
            duration: undoSendSeconds * 1000,
            undo: true,
            action: {
              label: "Undo",
              onClick: () => {
                if (settled.take()) {
                  navigate({ to: "/mail/compose", search: { draft: id } });
                }
              },
            },
            onExpire: () => {
              if (settled.take()) {
                deliver(fd);
              }
            },
            beacon: () =>
              settled.taken() ? null : { url: sendAction.url, body: fd },
          });
        } else {
          await deliver(fd);
        }

        leave();
      },
      () => setBusy(false)
    );
  };

  /** "Send later": saved as the draft and handed to the cron for `iso`; the toast can take it back. */
  const sendLater = async (iso: string) => {
    if (busy || gone.current) {
      return;
    }

    const fd = formData("schedule");

    const to =
      `${fd.get("to") ?? ""}${fd.get("cc") ?? ""}${fd.get("bcc") ?? ""}`.trim();

    if (!to) {
      setError("Add at least one recipient.");

      return;
    }

    fd.set("sendAt", iso);
    setBusy(true);

    await withCleanup(
      async () => {
        try {
          const result = await schedule({ data: fd });

          if (!result.ok) {
            setError(result.error);

            return;
          }

          const id = result.draftId;
          draftRef.current = id;
          setDirty(false);
          toast.show({
            message: `Scheduled for ${snoozeLabel(result.scheduledAt)}.`,
            action: {
              label: "Cancel send",
              onClick: async () => {
                await unschedule({ data: { draftId: id } });
                await router.invalidate();
                navigate({ to: "/mail/compose", search: { draft: id } });
              },
            },
          });
          await router.invalidate();
          leave();
        } catch (scheduleError) {
          setError(
            scheduleError instanceof Error
              ? scheduleError.message
              : String(scheduleError)
          );
        }
      },
      () => setBusy(false)
    );
  };

  const discard = async () => {
    if (draftRef.current) {
      await draft({ data: formData("discard") });
    }

    toast.show({ message: "Draft discarded." });
    leave();
  };

  const popOut = async () => {
    const id = await saveDraft();
    gone.current = true;
    onClose?.();
    navigate({ to: "/mail/compose", search: { draft: id ?? undefined } });
  };

  const inline = variant === "inline";

  return (
    // The form is the drop target for attachments and takes ⌘Enter to send; the Send and Attach buttons are the keyboard route to both.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a drop target and a send shortcut, each also a button inside
    <form
      ref={form}
      method="post"
      action={sendAction.url}
      encType="multipart/form-data"
      onSubmit={(e) => {
        e.preventDefault();
        sendNow();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) {
          return;
        }

        e.preventDefault();
        setDragging(false);
        uploadFiles([...e.dataTransfer.files]);
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          sendNow();
        }
      }}
      className={cx(
        "relative flex flex-col gap-2.5",
        inline &&
          "rounded-lg border border-line bg-elevated p-4 animate-rise-in",
        dragging && "ring-2 ring-(--ring)",
        className
      )}
      aria-label={title}
    >
      <ReplyFields prefill={prefill} />
      {dragging && (
        <div className="bg-accent-soft/70 text-md text-accent pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg font-medium">
          Drop files to attach them
        </div>
      )}
      {inline && (
        <div className="-mt-1 flex items-center gap-2">
          <span className="text-fg text-base font-medium">{title}</span>
          <span className="ml-auto flex items-center gap-0.5">
            <IconButton
              size="sm"
              label="Open in the full composer"
              onClick={() => {
                popOut();
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              size="sm"
              label="Close"
              onClick={async () => {
                if (dirty) {
                  await saveDraft();
                }

                leave();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </span>
        </div>
      )}
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <FromField froms={froms} from={prefill.from} onChange={touch} />
      <div className="flex items-start gap-2">
        <AddressField
          name="to"
          label="To"
          initial={prefill.to}
          autoFocus={!prefill.to && !inline}
          onChange={(to) => {
            touch();
            setRecipients((r) => ({ ...r, to }));
          }}
          className="min-w-0 flex-1"
        />
        {!showCc && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCc(true)}
            className="mt-0.5 shrink-0"
          >
            Cc / Bcc
          </Button>
        )}
      </div>
      {showCc && (
        <>
          <AddressField
            name="cc"
            label="Cc"
            initial={prefill.cc}
            onChange={(cc) => {
              touch();
              setRecipients((r) => ({ ...r, cc }));
            }}
          />
          <AddressField
            name="bcc"
            label="Bcc"
            initial={prefill.bcc}
            onChange={(bcc) => {
              touch();
              setRecipients((r) => ({ ...r, bcc }));
            }}
          />
        </>
      )}
      {!showCc && (
        <>
          <input type="hidden" name="cc" value={prefill.cc} />
          <input type="hidden" name="bcc" value={prefill.bcc} />
        </>
      )}
      <div className="flex items-center gap-2">
        <label
          htmlFor="compose-subject"
          className="text-muted w-12 shrink-0 text-sm font-medium"
        >
          Subject
        </label>
        <input
          id="compose-subject"
          name="subject"
          defaultValue={prefill.subject}
          onChange={touch}
          placeholder="Subject"
          className={inputClass}
        />
      </div>
      <RichEditor
        name="html"
        initialHtml={prefill.html}
        autoFocus={!!prefill.to || inline}
        onChange={() => touch()}
        onSubmit={() => {
          sendNow();
        }}
        handle={editor}
        className={inline ? "min-h-36" : ""}
      />
      <SignatureBlock signature={signature} />
      <AttachmentList
        files={files}
        uploading={uploading}
        onRemove={(file) => {
          removeFile(file);
        }}
      />
      <div className="border-line flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          title="Send (⌘Enter)"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
        <SnoozeMenu
          align="start"
          above
          heading="Send later"
          submitLabel="Schedule"
          presets={sendLaterPresets}
          width="w-80"
          onPick={(iso) => {
            sendLater(iso);
          }}
          renderTrigger={({ open, toggle }) => (
            <IconButton
              label="Send later"
              onClick={toggle}
              active={open}
              disabled={busy}
              aria-haspopup="dialog"
              aria-expanded={open}
            >
              <CalendarClock className="h-4 w-4" />
            </IconButton>
          )}
        />
        <label className="text-muted hover:bg-hover hover:text-fg inline-flex h-7 cursor-default items-center gap-1.5 rounded-md px-2 text-base font-medium">
          <Paperclip className="h-3.5 w-3.5" />
          Attach
          <input
            type="file"
            name="files"
            multiple
            className="sr-only"
            onChange={(e) => {
              const chosen = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              uploadFiles(chosen);
            }}
          />
        </label>
        {signatures.length > 0 && (
          <label className="text-muted flex items-center gap-2 text-sm">
            <span className="sr-only sm:not-sr-only">Signature</span>
            <select
              name="signatureId"
              value={signatureId}
              onChange={(e) => {
                setSignatureId(e.currentTarget.value);
                touch();
              }}
              className={cx(selectClass, "h-6 text-sm")}
              aria-label="Signature"
            >
              <option value="">No signature</option>
              {signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {pgp.hasKey && (
          <PgpSwitches
            initialSign={prefill.pgpSign}
            initialEncrypt={prefill.pgpEncrypt}
            recipients={recipients}
            onChange={touch}
          />
        )}
        <span className="text-subtle text-xs" aria-live="polite">
          {draftStatus(saving, dirty, savedAt)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {!inline && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await saveDraft();
                leave();
              }}
            >
              Close
            </Button>
          )}
          <IconButton
            label="Discard draft"
            onClick={() => {
              discard();
            }}
            className="text-red hover:text-red"
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </span>
      </div>
    </form>
  );
};
