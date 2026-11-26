import { Link, createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
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

import { ApplicationsSettings } from "~/components/applications-settings";
import { BrandingSettings } from "~/components/branding-settings";
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
  Checkbox,
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
import { accountIntent } from "~/lib/account.server";
import { useAction } from "~/lib/action";
import { formData, formPost } from "~/lib/forms";
import { groupsIntent } from "~/lib/groups.server";
import { unreachable } from "~/lib/guards";
import { keepShown } from "~/lib/keep-shown";
import { signatureIntent } from "~/lib/mail/signature-settings.server";
import { sanitizeSignatureHtml } from "~/lib/mail/signatures";
import { peopleIntent } from "~/lib/people.server";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";
import { SETTINGS_TABS, tabsFor } from "~/lib/settings";
import type { SettingsResult, SettingsTab } from "~/lib/settings";
import { loadSettings } from "~/lib/settings.server";
import { escapeHtml } from "~/lib/text";

const searchSchema = z.object({
  // A tab that is gone, or one the address mistyped, opens Account rather than failing the page.
  tab: z.enum(SETTINGS_TABS).optional().catch(undefined),
  // How connecting a mailbox for an import went (`finishMicrosoftConnect`), and Microsoft's reason when it failed.
  connect: z.string().optional(),
  reason: z.coerce.string().optional(),
});

/** Who is looking and the open tab's slice alone: a tab only an admin sees opens Account for anyone else. */
const getSettings = createServerFn()
  .validator((d: { tab?: SettingsTab } | undefined) => {
    // A tab still on the build before this one calls without a payload and renders every tab's data from one
    // answer, which this answer no longer is: answered, that tab's page would break on its minute's refresh. Failing
    // keeps what it shows (`keepShown`) until it moves onto this build, which `deploy-watch` offers at once.
    if (d === undefined) {
      throw new Error(
        "Settings was asked by an earlier build: reload the page."
      );
    }

    return d;
  })
  .handler(async ({ data }) => {
    const { db, env, user, request } = await appContext();

    return loadSettings(db, env, user, request, data.tab);
  });

// Each tab's forms go to its concept's intent handler, which the tests call without the route.

const accountAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SettingsResult> => {
    const { db, env, user, request } = await appContext();

    const { cookie, ...result } = await accountIntent(
      db,
      env,
      user,
      data,
      request
    );

    // A new password renews the session: this browser goes on in the new one.
    if (cookie) {
      setResponseHeader("Set-Cookie", cookie);
    }

    return result;
  });

const signaturesAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SettingsResult> => {
    const { db, env, user } = await appContext();

    return signatureIntent(db, env, user, data);
  });

const peopleAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SettingsResult> => {
    const { db, env, user } = await appContext();

    return peopleIntent(db, env, user, data);
  });

const groupsAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SettingsResult> => {
    const { db, env, user } = await appContext();

    return groupsIntent(db, env, user, data);
  });

const Feedback = ({
  result,
  error,
}: {
  result?: SettingsResult;
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
  const act = useAction(signaturesAction, { id: s.id });
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
  const create = useAction(signaturesAction);
  const choose = useAction(signaturesAction);
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
}: Pick<TabData<"account">, "me" | "signatures"> & AccountData) => {
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

/** A person an admin removed, while the cron deletes what was theirs; nothing more is done to them. */
const RemovingRow = ({ person: p }: { person: Person }) => (
  <li className="flex items-center gap-3 p-4 opacity-60">
    <Avatar name={p.name} size={28} />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 text-base font-medium">
        <span className="truncate">{p.name}</span>
        <Pill tone="red">Being removed</Pill>
      </div>
      <div className="text-muted truncate text-sm">
        {p.email}
        <span className="text-subtle">
          {" · "}mail to them bounces; what was theirs goes over the next
          minutes
        </span>
      </div>
    </div>
  </li>
);

/** A person's primary address changed, with the old one kept as an alias unless the admin unticks it. */
const AddressForm = ({
  person: p,
  mailDomain,
}: {
  person: Person;
  mailDomain: string;
}) => {
  const act = useAction(peopleAction, { id: p.id });

  return (
    <div className="space-y-1">
      <act.Form className="flex flex-wrap items-center gap-2">
        <span className="text-muted text-sm">Address</span>
        <div className="flex items-center">
          <input
            name="address"
            required
            pattern="[^@\s]+"
            aria-label="New address"
            defaultValue={p.email.slice(0, p.email.indexOf("@"))}
            className={cx(inputClass, "h-6 w-40 rounded-r-none text-sm")}
          />
          <span className="border-line bg-hover text-muted flex h-6 items-center rounded-r-md border border-l-0 px-2 text-sm">
            @{mailDomain}
          </span>
        </div>
        <label className="text-muted flex items-center gap-1.5 text-sm">
          <Checkbox name="keepOld" defaultChecked />
          Keep {p.email} as an alias
        </label>
        <Button size="sm" type="submit" name="intent" value="address">
          <Pencil className="h-3.5 w-3.5" />
          Change address
        </Button>
      </act.Form>
      <Feedback result={act.data} error={act.error} />
    </div>
  );
};

/**
 * Removal, for a deactivated person other than the admin: the admin types their address to confirm, and the browser
 * asks once more, since nothing of theirs comes back.
 */
const RemovePerson = ({
  person: p,
  isMe,
}: {
  person: Person;
  isMe: boolean;
}) => {
  const act = useAction(peopleAction, { id: p.id });

  if (isMe) {
    return null;
  }

  if (p.active) {
    return (
      <p className="text-subtle text-sm">
        To remove {p.name} and everything that is theirs, deactivate them first.
      </p>
    );
  }

  return (
    <div className="border-line space-y-2 border-t pt-3">
      <act.Form
        className="space-y-2"
        onSubmit={(e) => {
          if (
            // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
            !confirm(`Remove ${p.name} for good? This cannot be undone.`)
          ) {
            e.preventDefault();
          }
        }}
      >
        <p className="text-muted text-sm">
          Removing {p.name} deletes their mail, their Drive with the files they
          shared, their signing requests, calendar, tasks and Assistant chats,
          for good. Mail to {p.email} and their aliases bounces, and the
          addresses can be given out again.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            name="confirm"
            required
            autoComplete="off"
            placeholder={p.email}
            aria-label={`Type ${p.email} to confirm`}
            className={cx(inputClass, "h-6 w-64 text-sm")}
          />
          <Button
            size="sm"
            variant="danger"
            type="submit"
            name="intent"
            value="remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove for good
          </Button>
        </div>
      </act.Form>
      <Feedback result={act.data} error={act.error} />
    </div>
  );
};

/**
 * One person: who they are and when they last signed in, with the actions an admin takes on them (role, address,
 * aliases, passwords, passkeys, the second factor, sessions, removal).
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
          <AddressForm person={p} mailDomain={mailDomain} />
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
          <RemovePerson person={p} isMe={isMe} />
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
        {people.map((p) =>
          p.removing ? (
            <RemovingRow key={p.id} person={p} />
          ) : (
            <PersonRow
              key={p.id}
              person={p}
              mailDomain={mailDomain}
              isMe={p.id === meId}
            />
          )
        )}
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

/** What a group's mode means, in a line, for the list and the form that makes one. */
const MODE_LINE: Record<GroupRow["mode"], string> = {
  distribute: "Each member gets a copy in their own inbox.",
  shared: "One inbox the members share in Mail.",
};

/** A confirmation before a submit that cannot be undone; the submit goes on only when the person agrees. */
const confirmFirst =
  (question: string) => (e: { preventDefault: () => void }) => {
    // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
    if (!confirm(question)) {
      e.preventDefault();
    }
  };

/** One group: its address and mode, its members, and what the person may change of it. */
const GroupItem = ({
  group: g,
  people,
  isAdmin,
}: {
  group: GroupRow;
  people: GroupsData["people"];
  isAdmin: boolean;
}) => {
  const act = useAction(groupsAction, { id: g.id });
  const [renaming, setRenaming] = useState(false);
  const inGroup = new Set(g.members.map((m) => m.id));
  const addable = people.filter((p) => !inGroup.has(p.id));

  return (
    <li className={cx("space-y-2 p-4", !g.active && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Avatar name={g.name} size={28} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <act.Form
              className="flex items-center gap-1"
              onSubmit={() => setRenaming(false)}
            >
              <input
                name="name"
                autoFocus
                required
                defaultValue={g.name}
                aria-label="Group name"
                className={cx(inputClass, "h-6 w-56 text-sm")}
              />
              <Button size="sm" type="submit" name="intent" value="rename">
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRenaming(false)}
              >
                Cancel
              </Button>
            </act.Form>
          ) : (
            <div className="flex items-center gap-2 text-base font-medium">
              <span className="truncate">{g.name}</span>
              <Pill tone={g.mode === "shared" ? "accent" : "neutral"}>
                {g.mode === "shared" ? "Shared inbox" : "Distribution"}
              </Pill>
              {!g.active && <Pill tone="amber">Off</Pill>}
              {g.myRole === "owner" && (
                <span className="text-subtle text-xs">you own it</span>
              )}
            </div>
          )}
          <div className="text-muted truncate text-sm">
            {g.email}
            <span className="text-subtle">
              {" · "}
              {MODE_LINE[g.mode]}
            </span>
          </div>
        </div>
        {g.canManage && (
          <act.Form className="flex flex-wrap items-center gap-1">
            {!renaming && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRenaming(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </Button>
            )}
            {isAdmin && (
              <Button
                size="sm"
                variant="ghost"
                type="submit"
                name="intent"
                value={g.active ? "deactivate" : "activate"}
                onClick={
                  g.active
                    ? confirmFirst(
                        `Turn ${g.email} off? Mail to it bounces until it is on again.`
                      )
                    : undefined
                }
              >
                {g.active ? "Turn off" : "Turn on"}
              </Button>
            )}
            {isAdmin && g.mode === "distribute" && (
              <Button
                size="sm"
                variant="ghost"
                type="submit"
                name="intent"
                value="delete"
                title="Delete group"
                aria-label={`Delete ${g.name}`}
                onClick={confirmFirst(
                  `Delete ${g.email}? Mail to it bounces from now on; what its members received stays with them.`
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </act.Form>
        )}
      </div>
      <ul className="space-y-1 pl-10">
        {g.members.map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-sm">
            <span className={cx("min-w-0 truncate", !m.active && "opacity-60")}>
              {m.name} <span className="text-subtle">{m.email}</span>
            </span>
            {m.role === "owner" && <Pill tone="accent">Owner</Pill>}
            {!m.active && <Pill tone="amber">Deactivated</Pill>}
            {g.canManage && (
              <act.Form className="ml-auto flex items-center gap-1">
                <input type="hidden" name="userId" value={m.id} />
                <Button
                  size="sm"
                  variant="ghost"
                  type="submit"
                  name="intent"
                  value={m.role === "owner" ? "member" : "owner"}
                >
                  {m.role === "owner" ? "Make member" : "Make owner"}
                </Button>
                <button
                  type="submit"
                  name="intent"
                  value="remove"
                  aria-label={`Remove ${m.name} from ${g.name}`}
                  className="text-subtle hover:bg-hover hover:text-fg rounded-full p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </act.Form>
            )}
          </li>
        ))}
        {!g.members.length && (
          <li className="text-subtle text-sm">
            {g.mode === "distribute"
              ? "No members yet: mail to it bounces."
              : "No members yet: its mail waits for someone to read it."}
          </li>
        )}
      </ul>
      {g.canManage && addable.length > 0 && (
        <act.Form className="flex flex-wrap items-center gap-1 pl-10">
          <select
            name="email"
            required
            defaultValue=""
            aria-label={`Add someone to ${g.name}`}
            className={cx(selectClass, "h-6 text-sm")}
          >
            <option value="" disabled>
              Add someone…
            </option>
            {addable.map((p) => (
              <option key={p.id} value={p.email}>
                {p.name} ({p.email})
              </option>
            ))}
          </select>
          <select
            name="role"
            defaultValue="member"
            aria-label="Their role in the group"
            className={cx(selectClass, "h-6 text-sm")}
          >
            <option value="member">Member</option>
            <option value="owner">Owner</option>
          </select>
          <Button size="sm" type="submit" name="intent" value="add">
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </act.Form>
      )}
      <div className="pl-10">
        <Feedback result={act.data} error={act.error} />
      </div>
    </li>
  );
};

/** Settings → Groups: every group for an admin, the ones a person is in for anyone else. */
const Groups = ({ groups, people, canCreate, mailDomain }: GroupsData) => {
  const create = useAction(groupsAction);
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="Groups"
      actions={
        canCreate && (
          <Button
            size="sm"
            onClick={() => setAdding((a) => !a)}
            aria-expanded={adding}
          >
            <Plus className="h-3.5 w-3.5" />
            New group
          </Button>
        )
      }
    >
      {adding && (
        <create.Form className="border-line bg-sidebar space-y-3 border-b p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="Its mail goes out under this name.">
              <input name="name" required className={inputClass} />
            </Field>
            <Field
              label="Address"
              hint={`Before the @; the address is on ${mailDomain}.`}
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
          </div>
          <fieldset className="space-y-1">
            <legend className="text-muted mb-1 text-sm font-medium">
              Kind
            </legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="mode"
                value="distribute"
                defaultChecked
                className="mt-0.5"
              />
              <span>
                Distribution group{" "}
                <span className="text-muted">{MODE_LINE.distribute}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="mode"
                value="shared"
                className="mt-0.5"
              />
              <span>
                Shared inbox{" "}
                <span className="text-muted">{MODE_LINE.shared}</span>
              </span>
            </label>
          </fieldset>
          <Feedback result={create.data} error={create.error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              name="intent"
              value="create"
              variant="primary"
              loading={create.state === "submitting"}
            >
              Create group
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </create.Form>
      )}
      <ul className="divide-line divide-y">
        {groups.map((g) => (
          <GroupItem key={g.id} group={g} people={people} isAdmin={canCreate} />
        ))}
      </ul>
      {!groups.length && (
        <div className="text-muted p-6 text-center text-base">
          <Users className="mx-auto mb-2 h-4 w-4" />
          {canCreate
            ? "No groups yet. A group gives several people one address."
            : "You are not in any group."}
        </div>
      )}
    </Section>
  );
};

/** Each tab's name in the header. */
const TAB_LABELS: Record<SettingsTab, string> = {
  account: "Account",
  mail: "Mail",
  tasks: "Tasks",
  groups: "Groups",
  people: "People",
  drive: "Drive",
  branding: "Branding",
  applications: "Applications",
};

/** The open tab, from the slice the loader answered for it alone. */
const TabBody = ({
  settings,
  connect,
  reason,
}: {
  settings: LoaderData;
  connect: string | undefined;
  reason: string | undefined;
}) => {
  switch (settings.tab) {
    case "mail": {
      return (
        <MailSettings {...settings.mail} connect={connect} reason={reason} />
      );
    }

    case "tasks": {
      return <TasksSettings github={settings.tasks.github} />;
    }

    case "groups": {
      return <Groups {...settings.groups} />;
    }

    case "people": {
      return <People {...settings.people} meId={settings.me.id} />;
    }

    case "drive": {
      return <DriveSettings {...settings.drive} />;
    }

    case "branding": {
      return <BrandingSettings {...settings.branding} />;
    }

    case "applications": {
      return <ApplicationsSettings {...settings.applications} />;
    }

    case "account": {
      return (
        <Account
          me={settings.me}
          signatures={settings.signatures}
          {...settings.account}
        />
      );
    }

    default: {
      return unreachable(settings, "Settings tab");
    }
  }
};

const SettingsPage = () => {
  const settings = Route.useLoaderData();
  const { connect, reason } = Route.useSearch();

  return (
    <>
      <ViewHeader title="Settings">
        <div className="bg-hover flex items-center gap-0.5 rounded-md p-0.5">
          {tabsFor(settings.me.role).map((key) => (
            <Link
              key={key}
              to="/settings"
              search={{ tab: key }}
              replace
              className={cx(
                "h-6 rounded-[5px] px-2 text-sm leading-6 transition-colors duration-100",
                settings.tab === key
                  ? "bg-elevated text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-muted hover:text-fg"
              )}
              aria-current={settings.tab === key ? "page" : undefined}
            >
              {TAB_LABELS[key]}
            </Link>
          ))}
        </div>
      </ViewHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-4 py-4">
          <TabBody settings={settings} connect={connect} reason={reason} />
        </div>
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
  // The open tab alone: another tab is another load. `connect` and `reason` stay out, as nothing loads them.
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  // Settings stay when the minute's refresh cannot load them again (#3548): an error state in their place would take
  // what is being typed into a form with it.
  loader: (run) =>
    keepShown(run, () => getSettings({ data: run.deps, fetch: serverFnFetch })),
  head: () => ({ meta: [{ title: "Settings · Workspace" }] }),
  component: SettingsPage,
  errorComponent: SettingsError,
});

type LoaderData = (typeof Route)["types"]["loaderData"];

/** What the loader answers when this tab is open. */
type TabData<Tab extends SettingsTab> = Extract<LoaderData, { tab: Tab }>;

type AccountData = TabData<"account">["account"];

type RecoveryRow = AccountData["recoveryAddresses"][number];

type SignatureRow = TabData<"account">["signatures"][number];

type Person = TabData<"people">["people"]["people"][number];

type GroupsData = TabData<"groups">["groups"];

type GroupRow = GroupsData["groups"][number];

type SessionRow = AccountData["sessions"][number];
