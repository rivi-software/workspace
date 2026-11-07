import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import {
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  Send,
  ShieldOff,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { DriveSettings } from "~/components/drive/drive-settings";
import { MailSettings } from "~/components/mail-settings";
import { SignaturePreview } from "~/components/message-body";
import { Passkeys } from "~/components/passkeys";
import { RichEditor } from "~/components/rich-editor";
import { SectionError } from "~/components/section-error";
import { TasksSettings } from "~/components/tasks/settings";
import { TwoFactor } from "~/components/two-factor";
import {
  Avatar,
  Button,
  Field,
  Notice,
  Pill,
  Section,
  Timestamp,
  ViewHeader,
  cx,
  inputClass,
  selectClass,
  textareaClass,
} from "~/components/ui";
import { schema } from "~/db";
import { useAction } from "~/lib/action";
import {
  endSession,
  listSessions,
  removeAllPasskeys,
  resetTwoFactor,
  revoke,
} from "~/lib/auth.server";
import { externalShareRecords } from "~/lib/drive/links.server";
import { field, formData, formPost } from "~/lib/forms";
import { keepShown } from "~/lib/keep-shown";
import { listFilters } from "~/lib/mail/filters.server";
import { listImageSenders } from "~/lib/mail/images.server";
import { importView, latestImport } from "~/lib/mail/import/import.server";
import { microsoftConfigured } from "~/lib/mail/import/microsoft.server";
import { listLabels } from "~/lib/mail/labels.server";
import { listPeerKeys, ownKeyView } from "~/lib/mail/pgp/keys.server";
import { parsePreferences } from "~/lib/mail/preferences";
import { sanitizeSignatureHtml } from "~/lib/mail/signatures";
import {
  SignatureError,
  deleteSignature,
  listSignatures,
  saveSignature,
  setDefaultSignatures,
} from "~/lib/mail/signatures.server";
import { learntTotals, listSenderRules } from "~/lib/mail/spam.server";
import {
  MAX_RECOVERY_ADDRESSES,
  RecoveryError,
  addRecoveryAddress,
  listRecoveryAddresses,
  removeRecoveryAddress,
  resendConfirmation,
} from "~/lib/recovery.server";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";
import { githubConnection } from "~/lib/tasks/github.server";
import { escapeHtml } from "~/lib/text";
import {
  PeopleError,
  addAlias,
  changeOwnPassword,
  createPerson,
  listPeople,
  removeAlias,
  resetPassword,
  setPersonActive,
  setPersonRole,
  updateProfile,
} from "~/lib/users.server";
import { externalSharingSetting } from "~/lib/workspace-settings.server";

const searchSchema = z.object({
  tab: z.enum(["account", "mail", "tasks", "people", "drive"]).optional(),
  // How connecting a mailbox for an import went (`finishMicrosoftConnect`), and Microsoft's reason when it failed.
  connect: z.string().optional(),
  reason: z.coerce.string().optional(),
});

/** How many passkeys a person may add: a laptop, a phone, a key or two, with room to spare. */
const MAX_PASSKEYS = 10;

const getSettings = createServerFn().handler(async () => {
  const { db, user, env, request } = await appContext();
  const signatureRows = await listSignatures(db, user.id);
  const recoveryRows = await listRecoveryAddresses(db, user.id);
  const senderRules = await listSenderRules(db, user.id);
  const imageSenderRows = await listImageSenders(db, user.id);

  const passkeyRows = await db.query.passkeys.findMany({
    where: eq(schema.passkeys.userId, user.id),
    orderBy: (p, { asc }) => [asc(p.createdAt)],
  });

  return {
    me: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      lastSignInAt: user.lastSignInAt,
    },
    // Whether a password sign-in asks for an authenticator app's code (`<TwoFactor>`); a passkey sign-in never does.
    twoFactorEnabled: user.twoFactorEnabled,
    // What signs the person in without a password (`<Passkeys>`), oldest first.
    passkeys: passkeyRows.map((p) => ({
      id: p.id,
      name: p.name ?? "Passkey",
      createdAt: p.createdAt.toISOString(),
      backedUp: p.backedUp,
    })),
    maxPasskeys: MAX_PASSKEYS,
    // Every browser the person is signed in on, newest first, for signing one out from here.
    sessions: await listSessions(request, env, db, user.id),
    signatures: signatureRows.map(
      ({ id, name, text, html, isDefault, isReplyDefault }) => ({
        id,
        name,
        text,
        html,
        isDefault,
        isReplyDefault,
      })
    ),
    // Where a reset link goes when the person forgets their password (`app/lib/recovery.server.ts`).
    recoveryAddresses: recoveryRows.map(({ id, address, confirmedAt }) => ({
      id,
      address,
      confirmedAt,
    })),
    maxRecoveryAddresses: MAX_RECOVERY_ADDRESSES,
    mailDomain: env.MAIL_DOMAIN,
    people: user.role === "admin" ? await listPeople(db) : [],
    // Settings → Drive: sharing outside the workspace, and the record of every link and invite (#2836).
    drive:
      user.role === "admin"
        ? {
            sharing: await externalSharingSetting(db),
            records: await externalShareRecords(db),
          }
        : null,
    // Settings → Tasks: the person's own GitHub connection (#3111).
    tasks: { github: await githubConnection(db, user.id) },
    // Settings → Mail: how the list reads, the labels, the filters, spam, images and the vacation responder.
    mail: {
      preferences: parsePreferences(user.preferencesJson),
      labels: await listLabels(db, user.id),
      filters: await listFilters(db, user.id),
      spam: {
        senders: senderRules.map(({ sender, verdict }) => ({
          sender,
          verdict,
        })),
        learnt: await learntTotals(db, user.id),
        mailDomain: env.MAIL_DOMAIN,
      },
      imageSenders: imageSenderRows.map((s) => s.sender),
      vacation: {
        on: user.vacationOn,
        subject: user.vacationSubject,
        text: user.vacationText,
        from: user.vacationFrom,
        until: user.vacationUntil,
      },
      imports: await (async () => {
        const latest = await latestImport(db, user.id);

        return {
          configured: microsoftConfigured(env),
          latest: latest ? importView(latest) : null,
        };
      })(),
      // Settings → Mail → OpenPGP: the person's own key and the keys of the people they write to.
      pgp: {
        own: await ownKeyView(db, user.id),
        peers: await listPeerKeys(db, user.id),
        signByDefault: parsePreferences(user.preferencesJson).pgpSign,
        mailDomain: env.MAIL_DOMAIN,
      },
    },
  };
});

interface Result {
  error?: string;
  message?: string;
  password?: string;
}

/** A form field that is empty or missing as null, for an id that may be left out. */
const optionalField = (form: FormData, name: string): string | null =>
  field(form, name) || null;

const accountAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<Result> => {
    const { db, env, user, request } = await appContext();
    const intent = field(data, "intent");

    try {
      if (intent === "profile") {
        await updateProfile(db, user.id, { name: field(data, "name") });

        return { message: "Saved." };
      }

      if (intent === "signature") {
        const id = optionalField(data, "id");
        await saveSignature(db, user.id, {
          id,
          name: field(data, "name"),
          text: field(data, "text"),
          html: data.has("html") ? field(data, "html") : null,
        });

        return { message: id ? "Saved." : "Signature added." };
      }

      if (intent === "default-signature") {
        await setDefaultSignatures(db, user.id, {
          new: optionalField(data, "signatureId"),
          reply: optionalField(data, "replySignatureId"),
        });

        return { message: "Saved." };
      }

      if (intent === "delete-signature") {
        await deleteSignature(db, user.id, field(data, "id"));

        return { message: "Signature deleted." };
      }

      if (intent === "signout-all") {
        // Every session of the person is over, this one included: the sign-in page is next.
        await revoke(db, user.id, "sign-out-everywhere");
        throw redirect({ href: "/login" });
      }

      if (intent === "revoke-session") {
        await endSession(db, user.id, field(data, "id"));

        return { message: "Signed out there." };
      }

      if (intent === "password") {
        // Every other session ended with the old password; this browser goes on, in the new session Better Auth
        // made for it when it made one.
        const cookie = await changeOwnPassword(request, env, {
          current: field(data, "current"),
          password: field(data, "password"),
          confirm: field(data, "confirm"),
        });

        if (cookie) {
          setResponseHeader("Set-Cookie", cookie);
        }

        return {
          message:
            "Password changed. Every other browser and device is signed out.",
        };
      }

      if (intent === "recovery-add") {
        const address = await addRecoveryAddress(env, db, user, {
          address: field(data, "address"),
          password: field(data, "current"),
        });

        return { message: `We sent a confirmation link to ${address}.` };
      }

      if (intent === "recovery-resend") {
        const address = await resendConfirmation(
          env,
          db,
          user,
          field(data, "id")
        );

        return { message: `Sent again to ${address}.` };
      }

      if (intent === "recovery-remove") {
        await removeRecoveryAddress(db, user.id, field(data, "id"));

        return { message: "Recovery address removed." };
      }
    } catch (error) {
      if (
        error instanceof PeopleError ||
        error instanceof SignatureError ||
        error instanceof RecoveryError
      ) {
        return { error: error.message };
      }

      throw error;
    }

    return {};
  });

const peopleAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<Result> => {
    const { db, env, user } = await appContext();

    if (user.role !== "admin") {
      return { error: "Only an admin can manage people." };
    }

    const intent = field(data, "intent");
    const id = field(data, "id");

    try {
      switch (intent) {
        case "create": {
          const created = await createPerson(db, env, {
            email: field(data, "email"),
            name: field(data, "name"),
            role: field(data, "role") === "admin" ? "admin" : "member",
          });

          return {
            message: `${created.email} is ready. Their one-time password:`,
            password: created.password,
          };
        }

        case "deactivate": {
          await setPersonActive(db, user, id, false);

          return { message: "Deactivated." };
        }

        case "activate": {
          await setPersonActive(db, user, id, true);

          return { message: "Reactivated." };
        }

        case "admin": {
          await setPersonRole(db, user, id, "admin");

          return { message: "Now an admin." };
        }

        case "member": {
          await setPersonRole(db, user, id, "member");

          return { message: "Now a member." };
        }

        case "reset": {
          const password = await resetPassword(db, id);

          return {
            message: "Signed out everywhere. Their new one-time password:",
            password,
          };
        }

        case "alias": {
          const address = await addAlias(db, env, id, field(data, "alias"));

          return { message: `${address} now reaches this mailbox.` };
        }

        case "unalias": {
          await removeAlias(db, id, field(data, "alias"));

          return { message: "Alias removed." };
        }

        case "signout": {
          await revoke(db, id, "sign-out-everywhere");

          return {
            message:
              "Signed out everywhere: their next request asks them to sign in.",
          };
        }

        case "recovery-remove": {
          await removeRecoveryAddress(db, id, field(data, "recoveryId"));

          return { message: "Recovery address removed." };
        }

        case "passkeys-remove": {
          // A lost device: the person signs in with their password until they add another.
          const removed = await removeAllPasskeys(db, id);

          return {
            message:
              removed === 1
                ? "Passkey removed."
                : `${removed} passkeys removed.`,
          };
        }

        case "two-factor-reset": {
          // A lost authenticator: its secret and backup codes go, and the password alone signs them in again.
          await resetTwoFactor(db, id);

          return {
            message:
              "Two-factor authentication reset: their next password sign-in needs no code until they set up an authenticator app again.",
          };
        }

        default: {
          break;
        }
      }
    } catch (error) {
      if (error instanceof PeopleError) {
        return { error: error.message };
      }

      throw error;
    }

    return {};
  });

const Feedback = ({
  result,
  error,
}: {
  result?: Result;
  error: string | null;
}) => {
  const message = result?.error ?? error;

  if (message) {
    return <Notice tone="error">{message}</Notice>;
  }

  if (result?.message) {
    return (
      <Notice tone="success">
        {result.message}
        {result.password && (
          <code className="bg-elevated text-fg ml-2 rounded px-1.5 py-0.5 font-mono text-sm select-all">
            {result.password}
          </code>
        )}
      </Notice>
    );
  }

  return null;
};

/** Its own component, so closing it forgets what it said; it closes once the address is added. */
const AddRecoveryAddress = ({ onDone }: { onDone: () => void }) => {
  const act = useAction(accountAction);
  useEffect(() => {
    if (act.data?.message) {
      onDone();
    }
  }, [act.data, onDone]);

  return (
    <act.Form className="border-line bg-sidebar space-y-3 border-b p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Address" hint="We send it a link to confirm it.">
          <input
            name="address"
            type="email"
            required
            autoFocus
            placeholder="you@gmail.com"
            className={inputClass}
          />
        </Field>
        <Field label="Current password" hint="A recovery address can reset it.">
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
          />
        </Field>
      </div>
      <Feedback result={act.data} error={act.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          name="intent"
          value="recovery-add"
          variant="primary"
          loading={act.state === "submitting"}
        >
          Add address
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </act.Form>
  );
};

const RecoveryAddressItem = ({ address: a }: { address: RecoveryRow }) => {
  const act = useAction(accountAction, { id: a.id });

  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-base">{a.address}</span>
        {a.confirmedAt ? (
          <Pill tone="accent">Confirmed</Pill>
        ) : (
          <Pill tone="amber">Not confirmed</Pill>
        )}
        <act.Form className="ml-auto flex items-center gap-1">
          {!a.confirmedAt && (
            <Button
              size="sm"
              variant="ghost"
              type="submit"
              name="intent"
              value="recovery-resend"
              loading={act.state === "submitting"}
            >
              <Send className="h-3.5 w-3.5" />
              Send again
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            type="submit"
            name="intent"
            value="recovery-remove"
            className="hover:text-red"
            onClick={(e) => {
              if (
                // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                !confirm(`Remove ${a.address} from your recovery addresses?`)
              ) {
                e.preventDefault();
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        </act.Form>
      </div>
      {!a.confirmedAt && (
        <p className="text-subtle text-sm">
          Open the link we sent to it within 24 hours. Until then, no reset link
          goes there.
        </p>
      )}
      <Feedback result={act.data} error={act.error} />
    </li>
  );
};

/** Where a link to choose a new password goes when the person forgets theirs (`/forgot-password`). */
const RecoveryAddresses = ({
  addresses,
  max,
  mailDomain,
}: {
  addresses: RecoveryRow[];
  max: number;
  mailDomain: string;
}) => {
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="Recovery addresses"
      actions={
        addresses.length < max && (
          <Button
            size="sm"
            onClick={() => setAdding((a) => !a)}
            aria-expanded={adding}
          >
            <Plus className="h-3.5 w-3.5" />
            Add address
          </Button>
        )
      }
    >
      <p className="border-line text-muted border-b px-4 py-3 text-sm">
        If you forget your password, “Forgot your password?” on the sign-in page
        sends a link to choose a new one to each confirmed address. Use a
        personal address outside {mailDomain}; admins can see these addresses.
      </p>
      {adding && <AddRecoveryAddress onDone={() => setAdding(false)} />}
      {addresses.length > 0 ? (
        <ul className="divide-line divide-y">
          {addresses.map((a) => (
            <RecoveryAddressItem key={a.id} address={a} />
          ))}
        </ul>
      ) : (
        !adding && (
          <div className="text-muted p-6 text-center text-base">
            No recovery address yet: a forgotten password needs an admin.
          </div>
        )
      )}
    </Section>
  );
};

/**
 * The name and the signature itself: written in the rich editor (with images, a logo), or as HTML pasted from a
 * signature generator, previewed in the mail frame as recipients read it. Either way the form posts `html`.
 */
/** One of the defaults in Settings: a signature, or none. */
const SignatureSelect = ({
  name,
  signatures,
  defaultValue,
}: {
  name: string;
  signatures: SignatureRow[];
  defaultValue: string | undefined;
}) => (
  <select
    name={name}
    defaultValue={defaultValue ?? ""}
    className={cx(selectClass, "w-full")}
  >
    <option value="">No signature</option>
    {signatures.map((s) => (
      <option key={s.id} value={s.id}>
        {s.name}
      </option>
    ))}
  </select>
);

/** A plain-text signature as the editor's markup: a line a block, as the editor writes them. */
const textAsHtml = (text: string): string =>
  text
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `<div>${escapeHtml(line) || "<br>"}</div>`)
    .join("");

const SignatureFields = ({ signature }: { signature?: SignatureRow }) => {
  const [mode, setMode] = useState<"rich" | "html">("rich");

  const [markup, setMarkup] = useState(() =>
    signature ? (signature.html ?? textAsHtml(signature.text)) : ""
  );

  // What the rich editor starts from: set when it opens, never while typing (it would reset the caret).
  const [seed, setSeed] = useState(markup);
  const [imageError, setImageError] = useState<string | null>(null);

  const preview = useMemo(
    () => (mode === "html" ? sanitizeSignatureHtml(markup) : ""),
    [mode, markup]
  );

  const switchTo = (next: "rich" | "html") => {
    if (next === "rich") {
      setSeed(markup);
    }

    setMode(next);
  };

  return (
    <>
      <Field label="Name" hint="Only you see it, in the composer's list.">
        <input
          name="name"
          defaultValue={signature?.name}
          required
          autoFocus
          placeholder="Work"
          className={inputClass}
        />
      </Field>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-muted text-sm font-medium">Signature</span>
          <div
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a segmented control of toggle buttons: a fieldset brings a border, padding and min-width of its own
            role="group"
            aria-label="Write the signature as"
            className="bg-hover ml-auto flex items-center gap-0.5 rounded-md p-0.5"
          >
            {(
              [
                ["rich", "Rich text"],
                ["html", "HTML"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => switchTo(value)}
                aria-pressed={mode === value}
                className={cx(
                  "h-5 rounded-[5px] px-2 text-xs transition-colors duration-100",
                  mode === value
                    ? "bg-elevated text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                    : "text-muted hover:text-fg"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {mode === "rich" ? (
          <RichEditor
            name="html"
            label="Signature"
            placeholder="Your name, role, phone number…"
            initialHtml={seed}
            onChange={setMarkup}
            images
            onImageError={setImageError}
          />
        ) : (
          <>
            <textarea
              name="html"
              value={markup}
              onChange={(e) => setMarkup(e.currentTarget.value)}
              rows={8}
              spellCheck={false}
              aria-label="Signature HTML"
              className={cx(textareaClass, "font-mono text-sm")}
            />
            <p className="text-subtle text-xs">
              Paste the HTML of a signature generator. Inline styles and tables
              stay; scripts, forms and style blocks go. Recipients see this:
            </p>
            {preview ? (
              <SignaturePreview
                html={preview}
                className="border-line bg-elevated rounded-md border px-3 py-2"
              />
            ) : null}
          </>
        )}
        {imageError && (
          <Notice tone="error" onDismiss={() => setImageError(null)}>
            {imageError}
          </Notice>
        )}
      </div>
    </>
  );
};

const SignatureItem = ({ signature: s }: { signature: SignatureRow }) => {
  const act = useAction(accountAction, { id: s.id });
  const [editing, setEditing] = useState(false);

  return (
    <li className="space-y-2 p-4">
      {editing ? (
        <act.Form className="space-y-3" onSubmit={() => setEditing(false)}>
          <SignatureFields signature={s} />
          <div className="flex gap-2">
            <Button
              type="submit"
              name="intent"
              value="signature"
              variant="primary"
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </act.Form>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-medium">{s.name}</span>
            {s.isDefault && <Pill tone="accent">New messages</Pill>}
            {s.isReplyDefault && (
              <Pill tone="accent">Replies and forwards</Pill>
            )}
            <act.Form className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="submit"
                name="intent"
                value="delete-signature"
                className="hover:text-red"
                onClick={(e) => {
                  // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                  if (!confirm(`Delete the signature “${s.name}”?`)) {
                    e.preventDefault();
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </act.Form>
          </div>
          {s.html ? (
            <SignaturePreview
              html={s.html}
              className="max-h-60 overflow-y-auto"
            />
          ) : (
            <p className="text-muted text-sm leading-5 whitespace-pre-wrap">
              {s.text}
            </p>
          )}
        </>
      )}
      <Feedback result={act.data} error={act.error} />
    </li>
  );
};

const Signatures = ({ signatures }: { signatures: SignatureRow[] }) => {
  const create = useAction(accountAction);
  const choose = useAction(accountAction);
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="Signatures"
      actions={
        <Button
          size="sm"
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
        >
          <Plus className="h-3.5 w-3.5" />
          Add signature
        </Button>
      }
    >
      {adding && (
        <create.Form
          className="border-line bg-sidebar space-y-3 border-b p-4"
          onSubmit={() => setAdding(false)}
        >
          <SignatureFields />
          <div className="flex gap-2">
            <Button
              type="submit"
              name="intent"
              value="signature"
              variant="primary"
            >
              Add signature
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </create.Form>
      )}
      {/* The form closes on submit and the new row says it was added; only a failure is told here. */}
      {(create.data?.error || create.error) && (
        <div className="border-line border-b p-4">
          <Feedback result={create.data} error={create.error} />
        </div>
      )}
      {signatures.length > 0 ? (
        <>
          <choose.Form className="border-line space-y-3 border-b p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="New messages"
                hint="What the composer starts a new message on."
              >
                <SignatureSelect
                  name="signatureId"
                  signatures={signatures}
                  defaultValue={signatures.find((s) => s.isDefault)?.id}
                />
              </Field>
              <Field
                label="Replies and forwards"
                hint="What a reply or forward starts on."
              >
                <SignatureSelect
                  name="replySignatureId"
                  signatures={signatures}
                  defaultValue={signatures.find((s) => s.isReplyDefault)?.id}
                />
              </Field>
            </div>
            <p className="text-subtle text-xs">
              You can pick another signature in the composer.
            </p>
            <Feedback result={choose.data} error={choose.error} />
            <Button
              type="submit"
              name="intent"
              value="default-signature"
              loading={choose.state === "submitting"}
            >
              Save defaults
            </Button>
          </choose.Form>
          <ul className="divide-line divide-y">
            {signatures.map((s) => (
              <SignatureItem key={s.id} signature={s} />
            ))}
          </ul>
        </>
      ) : (
        !adding && (
          <div className="text-muted p-6 text-center text-base">
            No signatures yet. One goes under a message after a “-- ” line.
          </div>
        )
      )}
    </Section>
  );
};

/** One browser the person is signed in on, with the way to sign it out from here. */
const SessionItem = ({ session: s }: { session: SessionRow }) => {
  const act = useAction(accountAction, { id: s.id });

  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-base"
          title={s.userAgent ?? undefined}
        >
          {s.userAgent ?? "Unknown browser"}
        </span>
        {s.current ? (
          <Pill tone="accent">Current</Pill>
        ) : (
          <act.Form>
            <Button
              size="sm"
              variant="ghost"
              type="submit"
              name="intent"
              value="revoke-session"
              loading={act.state === "submitting"}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </act.Form>
        )}
      </div>
      <div className="text-subtle flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {s.ipAddress && <span>{s.ipAddress}</span>}
        <span>
          Signed in <Timestamp iso={s.createdAt} />
        </span>
      </div>
      <Feedback result={act.data} error={act.error} />
    </li>
  );
};

const Account = ({
  me,
  signatures,
  twoFactorEnabled,
  passkeys,
  maxPasskeys,
  recoveryAddresses,
  maxRecoveryAddresses,
  mailDomain,
  sessions,
}: Pick<
  LoaderData,
  | "me"
  | "signatures"
  | "twoFactorEnabled"
  | "passkeys"
  | "maxPasskeys"
  | "recoveryAddresses"
  | "maxRecoveryAddresses"
  | "mailDomain"
  | "sessions"
>) => {
  const profile = useAction(accountAction);
  const password = useAction(accountAction);
  const signOut = useAction(accountAction);

  return (
    <>
      <Section title="Profile">
        <profile.Form className="space-y-3 p-4">
          <div className="flex items-center gap-3">
            <Avatar name={me.name} size={36} />
            <div>
              <div className="text-base font-medium">{me.name}</div>
              <div className="text-muted text-sm">{me.email}</div>
              <div className="text-subtle text-xs">
                {me.lastSignInAt ? (
                  <>
                    Last sign-in{" "}
                    <Timestamp iso={me.lastSignInAt} relative={false} />
                  </>
                ) : (
                  "No sign-in yet"
                )}
              </div>
            </div>
          </div>
          <Field label="Name">
            <input
              name="name"
              defaultValue={me.name}
              required
              className={inputClass}
            />
          </Field>
          <Feedback result={profile.data} error={profile.error} />
          <Button
            type="submit"
            name="intent"
            value="profile"
            variant="primary"
            loading={profile.state === "submitting"}
          >
            Save
          </Button>
        </profile.Form>
      </Section>
      <Signatures signatures={signatures} />
      <Section title="Password">
        <password.Form className="space-y-3 p-4">
          <Field label="Current password">
            <input
              name="current"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New password" hint="At least 12 characters.">
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                className={inputClass}
              />
            </Field>
            <Field label="Confirm">
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                className={inputClass}
              />
            </Field>
          </div>
          <Feedback result={password.data} error={password.error} />
          <Button
            type="submit"
            name="intent"
            value="password"
            variant="primary"
            loading={password.state === "submitting"}
          >
            Change password
          </Button>
        </password.Form>
      </Section>
      <Passkeys passkeys={passkeys} max={maxPasskeys} />
      <TwoFactor enabled={twoFactorEnabled} />
      <RecoveryAddresses
        addresses={recoveryAddresses}
        max={maxRecoveryAddresses}
        mailDomain={mailDomain}
      />
      <Section title="Sessions">
        <ul className="divide-line border-line divide-y border-b">
          {sessions.map((s) => (
            <SessionItem key={s.id} session={s} />
          ))}
        </ul>
        <signOut.Form className="flex flex-wrap items-center gap-3 p-4">
          <p className="text-muted min-w-0 flex-1 text-sm">
            Signed in somewhere you no longer are? Sign out of every browser and
            device at once, this one included.
          </p>
          <Button
            type="submit"
            name="intent"
            value="signout-all"
            loading={signOut.state === "submitting"}
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out everywhere
          </Button>
          <Feedback result={signOut.data} error={signOut.error} />
        </signOut.Form>
      </Section>
    </>
  );
};

/**
 * One person: who they are and when they last signed in, with the actions an admin takes on them (role, aliases,
 * passwords, passkeys, the second factor, sessions).
 */
const PersonRow = ({
  person: p,
  mailDomain,
  isMe,
}: {
  person: Person;
  mailDomain: string;
  isMe: boolean;
}) => {
  const act = useAction(peopleAction, { id: p.id });
  const [aliasing, setAliasing] = useState(false);
  const [managing, setManaging] = useState(false);

  return (
    <li className={cx("space-y-2 p-4", !p.active && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Avatar name={p.name} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-base font-medium">
            <span className="truncate">{p.name}</span>
            {p.role === "admin" && <Pill tone="accent">Admin</Pill>}
            {!p.active && <Pill tone="amber">Deactivated</Pill>}
            {isMe && <span className="text-subtle text-xs">you</span>}
          </div>
          <div className="text-muted truncate text-sm">
            {p.email}
            <span className="text-subtle">
              {" · "}
              {p.lastSignInAt ? (
                <>
                  signed in <Timestamp iso={p.lastSignInAt} />
                </>
              ) : (
                "never signed in"
              )}
            </span>
          </div>
        </div>
        <act.Form className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setManaging((m) => !m)}
            aria-expanded={managing}
          >
            <Pencil className="h-3.5 w-3.5" />
            Manage
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="submit"
            name="intent"
            value="reset"
            title="New one-time password"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Reset password
          </Button>
          {!isMe && (
            <Button
              size="sm"
              variant="ghost"
              type="submit"
              name="intent"
              value={p.active ? "deactivate" : "activate"}
            >
              {p.active ? "Deactivate" : "Reactivate"}
            </Button>
          )}
        </act.Form>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-10">
        {p.aliases.map((a) => (
          <act.Form key={a} className="contents">
            <input type="hidden" name="alias" value={a} />
            <span className="border-line text-muted inline-flex h-6 items-center gap-1 rounded-full border pr-1 pl-2 text-xs">
              {a}
              <button
                type="submit"
                name="intent"
                value="unalias"
                aria-label={`Remove alias ${a}`}
                className="hover:bg-hover hover:text-fg rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </act.Form>
        ))}
        {aliasing ? (
          <act.Form
            className="flex items-center gap-1"
            onSubmit={() => setAliasing(false)}
          >
            <input
              name="alias"
              autoFocus
              placeholder={`alias@${mailDomain}`}
              className={cx(inputClass, "h-6 w-48 text-sm")}
            />
            <Button size="sm" type="submit" name="intent" value="alias">
              Add
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAliasing(false)}
            >
              Cancel
            </Button>
          </act.Form>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAliasing(true)}>
            <Plus className="h-3 w-3" />
            Alias
          </Button>
        )}
      </div>
      {managing && (
        <div className="border-line bg-sidebar ml-10 space-y-3 rounded-md border p-3">
          {!isMe && (
            <act.Form className="flex flex-wrap items-center gap-2">
              <span className="text-muted text-sm">Workspace role</span>
              <Button
                size="sm"
                type="submit"
                name="intent"
                value={p.role === "admin" ? "member" : "admin"}
              >
                <UserRound className="h-3.5 w-3.5" />
                {p.role === "admin" ? "Make member" : "Make admin"}
              </Button>
            </act.Form>
          )}
          <div className="space-y-1">
            <div className="text-muted text-sm font-medium">
              Recovery addresses
            </div>
            {p.recoveryAddresses.length === 0 && (
              <p className="text-subtle text-sm">
                None: a forgotten password needs “Reset password” here.
              </p>
            )}
            {p.recoveryAddresses.map((r) => (
              <act.Form
                key={r.id}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <input type="hidden" name="recoveryId" value={r.id} />
                <span className="min-w-0 truncate">{r.address}</span>
                {r.confirmed ? (
                  <Pill tone="accent">Confirmed</Pill>
                ) : (
                  <Pill tone="amber">Not confirmed</Pill>
                )}
                <button
                  type="submit"
                  name="intent"
                  value="recovery-remove"
                  aria-label={`Remove recovery address ${r.address}`}
                  className="text-subtle hover:bg-hover hover:text-fg rounded-full p-0.5"
                  onClick={(e) => {
                    if (
                      // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                      !confirm(
                        `Remove ${r.address}? No reset link goes there afterwards.`
                      )
                    ) {
                      e.preventDefault();
                    }
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </act.Form>
            ))}
          </div>
          <act.Form className="flex flex-wrap items-center gap-2">
            <span className="text-muted text-sm">
              {p.passkeys === 0
                ? "No passkeys"
                : `${p.passkeys} ${p.passkeys === 1 ? "passkey" : "passkeys"}`}
              {p.twoFactorEnabled ? " · authenticator app" : ""}
            </span>
            {p.passkeys > 0 && (
              <Button
                size="sm"
                type="submit"
                name="intent"
                value="passkeys-remove"
                onClick={(e) => {
                  if (
                    // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                    !confirm(
                      `Remove all of ${p.name}'s passkeys? They sign in without one until they add another.`
                    )
                  ) {
                    e.preventDefault();
                  }
                }}
              >
                <KeyRound className="h-3.5 w-3.5" />
                Remove passkeys
              </Button>
            )}
            {p.twoFactorEnabled && (
              <Button
                size="sm"
                type="submit"
                name="intent"
                value="two-factor-reset"
                onClick={(e) => {
                  if (
                    // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                    !confirm(
                      `Reset ${p.name}'s two-factor authentication? Their next password sign-in needs no code until they set up an authenticator app again.`
                    )
                  ) {
                    e.preventDefault();
                  }
                }}
              >
                <ShieldOff className="h-3.5 w-3.5" />
                Reset two-factor
              </Button>
            )}
          </act.Form>
          <act.Form className="flex flex-wrap items-center gap-2">
            <span className="text-muted text-sm">Sessions</span>
            <Button size="sm" type="submit" name="intent" value="signout">
              <LogOut className="h-3.5 w-3.5" />
              Sign out everywhere
            </Button>
          </act.Form>
        </div>
      )}
      <div className="pl-10">
        <Feedback result={act.data} error={act.error} />
      </div>
    </li>
  );
};

const People = ({
  people,
  mailDomain,
  meId,
}: {
  people: Person[];
  mailDomain: string;
  meId: string;
}) => {
  const create = useAction(peopleAction);
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="People"
      actions={
        <Button
          size="sm"
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
        >
          <Plus className="h-3.5 w-3.5" />
          Add person
        </Button>
      }
    >
      {adding && (
        <create.Form className="border-line bg-sidebar space-y-3 border-b p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_120px]">
            <Field label="Name">
              <input name="name" required className={inputClass} />
            </Field>
            <Field
              label="Address"
              hint={`Before the @; the mailbox is on ${mailDomain}.`}
            >
              <div className="flex items-center">
                <input
                  name="email"
                  required
                  pattern="[^@\s]+"
                  className={cx(inputClass, "rounded-r-none")}
                />
                <span className="border-line bg-hover text-muted flex h-7 items-center rounded-r-md border border-l-0 px-2 text-sm">
                  @{mailDomain}
                </span>
              </div>
            </Field>
            <Field label="Role">
              <select
                name="role"
                defaultValue="member"
                className={cx(selectClass, "w-full")}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
          </div>
          <Feedback result={create.data} error={create.error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              name="intent"
              value="create"
              variant="primary"
              loading={create.state === "submitting"}
            >
              Create mailbox
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </create.Form>
      )}
      <ul className="divide-line divide-y">
        {people.map((p) => (
          <PersonRow
            key={p.id}
            person={p}
            mailDomain={mailDomain}
            isMe={p.id === meId}
          />
        ))}
      </ul>
      {!people.length && (
        <div className="text-muted p-6 text-center text-base">
          <Users className="mx-auto mb-2 h-4 w-4" />
          Nobody yet.
        </div>
      )}
    </Section>
  );
};

const SettingsPage = () => {
  const {
    me,
    signatures,
    people,
    mailDomain,
    twoFactorEnabled,
    passkeys,
    maxPasskeys,
    sessions,
    recoveryAddresses,
    maxRecoveryAddresses,
    mail,
    drive,
    tasks,
  } = Route.useLoaderData();

  const { tab = "account", connect, reason } = Route.useSearch();

  const tabs: ["account" | "mail" | "tasks" | "people" | "drive", string][] = [
    ["account", "Account"],
    ["mail", "Mail"],
    ["tasks", "Tasks"],
  ];

  if (me.role === "admin") {
    tabs.push(["people", "People"], ["drive", "Drive"]);
  }

  let body: React.ReactNode;

  if (tab === "mail") {
    body = <MailSettings {...mail} connect={connect} reason={reason} />;
  } else if (tab === "tasks") {
    body = <TasksSettings github={tasks.github} />;
  } else if (tab === "people" && me.role === "admin") {
    body = <People people={people} mailDomain={mailDomain} meId={me.id} />;
  } else if (tab === "drive" && drive) {
    body = <DriveSettings {...drive} />;
  } else {
    body = (
      <Account
        me={me}
        signatures={signatures}
        twoFactorEnabled={twoFactorEnabled}
        passkeys={passkeys}
        maxPasskeys={maxPasskeys}
        recoveryAddresses={recoveryAddresses}
        maxRecoveryAddresses={maxRecoveryAddresses}
        mailDomain={mailDomain}
        sessions={sessions}
      />
    );
  }

  return (
    <>
      <ViewHeader title="Settings">
        <div className="bg-hover flex items-center gap-0.5 rounded-md p-0.5">
          {tabs.map(([key, label]) => (
            <Link
              key={key}
              to="/settings"
              search={{ tab: key }}
              replace
              className={cx(
                "h-6 rounded-[5px] px-2 text-sm leading-6 transition-colors duration-100",
                tab === key
                  ? "bg-elevated text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-muted hover:text-fg"
              )}
              aria-current={tab === key ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </div>
      </ViewHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-4 py-4">{body}</div>
      </div>
    </>
  );
};

/** What takes Settings' place when it cannot load and there is nothing to keep (#3548). */
const SettingsError = ({ error }: ErrorComponentProps) => (
  <SectionError error={error} title="Settings didn't load" />
);

export const Route = createFileRoute("/_app/settings")({
  validateSearch: searchSchema,
  // Settings stay when the minute's refresh cannot load them again (#3548): an error state in their place would take
  // what is being typed into a form with it.
  loader: (run) => keepShown(run, () => getSettings({ fetch: serverFnFetch })),
  head: () => ({ meta: [{ title: "Settings · Workspace" }] }),
  component: SettingsPage,
  errorComponent: SettingsError,
});

type LoaderData = (typeof Route)["types"]["loaderData"];

type RecoveryRow = LoaderData["recoveryAddresses"][number];

type SignatureRow = LoaderData["signatures"][number];

type Person = LoaderData["people"][number];

type SessionRow = LoaderData["sessions"][number];
