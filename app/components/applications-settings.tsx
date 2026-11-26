import { AppWindow, KeyRound, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { Fragment, useState } from "react";

import { useAction } from "~/lib/action";
import type { SettingsResult } from "~/lib/settings";
import { applicationsAction } from "~/lib/sso/actions";
import type { ClientMemberView, SsoClientView } from "~/lib/sso/clients.server";

import {
  Avatar,
  Button,
  Checkbox,
  Field,
  Notice,
  Pill,
  Section,
  Timestamp,
  cx,
  inputClass,
  selectClass,
  textareaClass,
} from "./ui";

type Application = SsoClientView & { members: ClientMemberView[] };

interface PersonOption {
  id: string;
  name: string;
  email: string;
}

interface SigningKeyRow {
  kid: string;
  createdAt: string;
  retiredAt: string | null;
}

/** What a form answered: what went wrong, or what happened, and a secret to copy once. */
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

  if (!result?.message) {
    return null;
  }

  return (
    <Notice tone="success">
      {result.message}
      {result.password && (
        <code className="bg-elevated text-fg mt-1 block rounded px-1.5 py-0.5 font-mono text-sm break-all select-all">
          {result.password}
        </code>
      )}
    </Notice>
  );
};

/** The fields of an application's registration, empty for a new one. */
const ApplicationFields = ({ app }: { app?: SsoClientView }) => (
  <>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name">
        <input
          name="name"
          required
          defaultValue={app?.name}
          className={inputClass}
        />
      </Field>
      <Field
        label="Launch URL"
        hint="Where Apps in the account menu opens it; optional."
      >
        <input
          name="launchUrl"
          type="url"
          defaultValue={app?.launchUrl ?? ""}
          placeholder="https://app.example.com/"
          className={inputClass}
        />
      </Field>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="Redirect URIs"
        hint="One per line; matched exactly. https, or http on localhost."
      >
        <textarea
          name="redirectUris"
          required
          rows={3}
          defaultValue={app?.redirectUris.join("\n")}
          placeholder="https://app.example.com/auth/callback"
          className={textareaClass}
        />
      </Field>
      <Field
        label="Post-logout redirect URIs"
        hint="Where signing out may send the browser back to; optional."
      >
        <textarea
          name="postLogoutRedirectUris"
          rows={3}
          defaultValue={app?.postLogoutRedirectUris.join("\n")}
          className={textareaClass}
        />
      </Field>
    </div>
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        name="pkceRequired"
        value="on"
        defaultChecked={app ? app.pkceRequired : true}
      />
      Require PKCE (S256) on every authorization request
    </label>
    <fieldset className="grid gap-1 text-sm">
      <legend className="text-muted mb-1 block text-sm font-medium">
        Who can sign in
      </legend>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="access"
          value="everyone"
          defaultChecked={(app?.access ?? "everyone") === "everyone"}
          className="accent-accent"
        />
        Everyone with an active mailbox
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="access"
          value="listed"
          defaultChecked={app?.access === "listed"}
          className="accent-accent"
        />
        Only the people on its list, each with a role the application reads
      </label>
    </fieldset>
  </>
);

/** Who may sign in to an application with a list, and the role each has there. */
const Members = ({
  app,
  people,
}: {
  app: Application;
  people: PersonOption[];
}) => {
  const act = useAction(applicationsAction, { id: app.id });

  const candidates = people.filter(
    (p) => !app.members.some((m) => m.userId === p.id)
  );

  return (
    <div className="border-line bg-sidebar ml-7 space-y-2 rounded-md border p-3">
      <div className="text-muted text-sm font-medium">Who can sign in</div>
      <ul className="space-y-1">
        {app.members.map((m) => (
          <li
            key={m.userId}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <Avatar name={m.name} size={20} />
            <span
              className={cx("min-w-0 truncate", !m.active && "line-through")}
            >
              {m.name}
            </span>
            <span className="text-muted truncate">{m.email}</span>
            {m.role && <Pill tone="accent">{m.role}</Pill>}
            <act.Form className="contents">
              <input type="hidden" name="userId" value={m.userId} />
              <button
                type="submit"
                name="intent"
                value="member-remove"
                aria-label={`Remove ${m.email} from ${app.name}`}
                className="text-subtle hover:bg-hover hover:text-fg rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </act.Form>
          </li>
        ))}
        {!app.members.length && (
          <li className="text-subtle text-sm">
            Nobody yet: nobody can sign in.
          </li>
        )}
      </ul>
      {candidates.length > 0 && (
        <act.Form className="flex flex-wrap items-center gap-2">
          <select
            name="userId"
            aria-label="Person"
            className={cx(selectClass, "h-6 text-sm")}
            required
          >
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.email})
              </option>
            ))}
          </select>
          <input
            name="role"
            aria-label="Role"
            placeholder="role (optional)"
            className={cx(inputClass, "h-6 w-40 text-sm")}
          />
          <Button size="sm" type="submit" name="intent" value="member-set">
            <Plus className="h-3 w-3" />
            Add to the list
          </Button>
        </act.Form>
      )}
      <Feedback result={act.data} error={act.error} />
    </div>
  );
};

const ApplicationRow = ({
  app,
  people,
}: {
  app: Application;
  people: PersonOption[];
}) => {
  const act = useAction(applicationsAction, { id: app.id });
  const [editing, setEditing] = useState(false);

  return (
    <li className={cx("space-y-2 p-4", !app.active && "opacity-60")}>
      <div className="flex items-start gap-3">
        <AppWindow className="text-muted mt-1 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-base font-medium">
            <span className="truncate">{app.name}</span>
            {app.access === "listed" ? (
              <Pill tone="accent">
                {app.members.length}{" "}
                {app.members.length === 1 ? "person" : "people"} listed
              </Pill>
            ) : (
              <Pill>Everyone</Pill>
            )}
            {!app.pkceRequired && <Pill tone="amber">PKCE optional</Pill>}
            {!app.active && <Pill tone="amber">Deactivated</Pill>}
          </div>
          <div className="text-muted truncate text-sm">
            Client id{" "}
            <code className="text-fg font-mono text-xs select-all">
              {app.id}
            </code>
          </div>
          <ul className="text-subtle mt-1 space-y-0.5 text-xs">
            {app.redirectUris.map((uri) => (
              <li key={uri} className="truncate font-mono">
                {uri}
              </li>
            ))}
          </ul>
        </div>
        <act.Form className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="submit"
            name="intent"
            value="rotate"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Rotate secret
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="submit"
            name="intent"
            value={app.active ? "deactivate" : "activate"}
          >
            {app.active ? "Deactivate" : "Reactivate"}
          </Button>
        </act.Form>
      </div>
      {editing && (
        <act.Form
          className="border-line bg-sidebar space-y-3 rounded-md border p-3"
          onSubmit={() => setEditing(false)}
        >
          <ApplicationFields app={app} />
          <div className="flex gap-2">
            <Button
              type="submit"
              name="intent"
              value="update"
              variant="primary"
              size="sm"
            >
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </act.Form>
      )}
      {app.access === "listed" && <Members app={app} people={people} />}
      <div className="pl-7">
        <Feedback result={act.data} error={act.error} />
      </div>
    </li>
  );
};

/**
 * Settings → Applications, for an admin (single sign-on, docs/SSO.md): the provider's addresses, the applications that
 * sign people in through the workspace and who may sign in to each, and the key the tokens are signed with.
 */
export const ApplicationsSettings = ({
  applications,
  signingKeys,
  people,
  endpoints,
  duo,
}: {
  applications: Application[];
  signingKeys: SigningKeyRow[];
  people: PersonOption[];
  endpoints: Record<
    | "issuer"
    | "discovery"
    | "authorize"
    | "token"
    | "jwks"
    | "userinfo"
    | "logout",
    string
  >;
  duo: boolean;
}) => {
  const create = useAction(applicationsAction);
  const keys = useAction(applicationsAction);
  const [adding, setAdding] = useState(false);

  const addresses: [string, string][] = [
    ["Issuer", endpoints.issuer],
    ["Discovery", endpoints.discovery],
    ["Authorization", endpoints.authorize],
    ["Token", endpoints.token],
    ["Key set (JWKS)", endpoints.jwks],
    ["Userinfo", endpoints.userinfo],
    ["End session", endpoints.logout],
  ];

  return (
    <>
      <Section title="Single sign-on">
        <div className="space-y-3 p-4">
          <p className="text-muted text-sm">
            Applications sign people in through this workspace with OpenID
            Connect (the authorization code flow with PKCE), with their address
            as the identity. Register an application below, then give it these
            addresses with its client id and secret.
          </p>
          <p className="text-muted text-sm">
            {duo
              ? "Duo confirms every password sign-in. A passkey signs in on its own."
              : "Duo is off: the authenticator app confirms the password sign-in of whoever set one up, and a passkey signs in on its own. The ID token's amr says which."}
          </p>
          <dl className="grid grid-cols-[132px_1fr] gap-y-1 text-sm">
            {addresses.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="truncate font-mono text-xs select-all">
                  {value}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </Section>
      <Section
        title="Applications"
        actions={
          <Button
            size="sm"
            onClick={() => setAdding((open) => !open)}
            aria-expanded={adding}
          >
            <Plus className="h-3.5 w-3.5" />
            Add application
          </Button>
        }
      >
        {adding && (
          <create.Form className="border-line bg-sidebar space-y-3 border-b p-4">
            <ApplicationFields />
            <Feedback result={create.data} error={create.error} />
            <div className="flex gap-2">
              <Button
                type="submit"
                name="intent"
                value="create"
                variant="primary"
                loading={create.state === "submitting"}
              >
                Register application
              </Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Close
              </Button>
            </div>
          </create.Form>
        )}
        <ul className="divide-line divide-y">
          {applications.map((app) => (
            <ApplicationRow key={app.id} app={app} people={people} />
          ))}
        </ul>
        {!applications.length && (
          <div className="text-muted p-6 text-center text-base">
            <AppWindow className="mx-auto mb-2 h-4 w-4" />
            No applications yet.
          </div>
        )}
      </Section>
      <Section title="Signing key">
        <keys.Form className="space-y-3 p-4">
          <ul className="space-y-1 text-sm">
            {signingKeys.map((key) => (
              <li key={key.kid} className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{key.kid}</code>
                <span className="text-muted">
                  made <Timestamp iso={key.createdAt} relative={false} />
                </span>
                {key.retiredAt ? (
                  <Pill tone="amber">Retired</Pill>
                ) : (
                  <Pill tone="accent">Current</Pill>
                )}
              </li>
            ))}
            {!signingKeys.length && (
              <li className="text-muted">
                Made on first use, when the first application signs someone in.
              </li>
            )}
          </ul>
          <Feedback result={keys.data} error={keys.error} />
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              name="intent"
              value="rotate-key"
              loading={keys.state === "submitting"}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Rotate signing key
            </Button>
            <span className="text-subtle text-xs">
              Tokens signed with the previous key verify for another day;
              applications fetch the key set as they need it.
            </span>
          </div>
        </keys.Form>
      </Section>
    </>
  );
};
