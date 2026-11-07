import { Download, KeyRound, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { useAction } from "~/lib/action";
import { pgpAction } from "~/lib/mail/pgp/actions";
import type { PgpResult } from "~/lib/mail/pgp/actions";
import { groupedFingerprint } from "~/lib/mail/pgp/pgp";
import type { OwnKeyView, PeerKeyView } from "~/lib/mail/pgp/pgp";

import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Notice,
  Pill,
  Section,
  Timestamp,
  inputClass,
  textareaClass,
} from "./ui";

export interface PgpSettingsData {
  own: OwnKeyView | null;
  peers: PeerKeyView[];
  signByDefault: boolean;
  mailDomain: string;
}

/** Save text as a file, as the browser saves a download. */
const saveFile = (filename: string, text: string) => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/pgp-keys" })
  );

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const Feedback = ({
  result,
  error,
}: {
  result?: PgpResult;
  error: string | null;
}) => {
  const message = (result && !result.ok && result.error) || error;

  if (message) {
    return <Notice tone="error">{message}</Notice>;
  }

  return result?.ok ? <Notice tone="success">{result.message}</Notice> : null;
};

const SOURCE_LABELS: Record<PeerKeyView["source"], string> = {
  imported: "Imported",
  autocrypt: "From their mail",
  wkd: "From their domain",
};

const NoKey = () => {
  const act = useAction(pgpAction);

  return (
    <div className="space-y-3 p-4">
      <p className="text-muted text-base">
        With a key, you can sign what you send so people can tell it is yours
        and unchanged, and read mail encrypted to you. The workspace keeps the
        key and uses it for you, so search and the Assistant still read your
        mail: it protects mail on its way, not from the workspace itself.
      </p>
      <act.Form className="space-y-3">
        <Button
          type="submit"
          name="intent"
          value="generate"
          variant="primary"
          loading={act.state === "submitting"}
        >
          <KeyRound className="h-3.5 w-3.5" />
          Make a key
        </Button>
        <details className="group">
          <summary className="text-muted hover:text-fg cursor-default text-sm">
            Import a key you already have
          </summary>
          <div className="mt-3 space-y-3">
            <Field
              label="Private key"
              hint="The whole block, as GnuPG's --export-secret-keys --armor or a mail client's backup writes it."
            >
              <textarea
                name="privateKey"
                rows={6}
                spellCheck={false}
                autoComplete="off"
                placeholder="The whole armored block, BEGIN line to END line"
                className={`${textareaClass} font-mono text-xs`}
              />
            </Field>
            <Field label="Passphrase" hint="Leave empty for a key without one.">
              <input
                name="passphrase"
                type="password"
                autoComplete="off"
                className={inputClass}
              />
            </Field>
            <Button
              type="submit"
              name="intent"
              value="import"
              loading={act.state === "submitting"}
            >
              <Upload className="h-3.5 w-3.5" />
              Import key
            </Button>
          </div>
        </details>
      </act.Form>
      <Feedback result={act.data} error={act.error} />
    </div>
  );
};

const OwnKey = ({
  own,
  signByDefault,
  mailDomain,
}: {
  own: OwnKeyView;
  signByDefault: boolean;
  mailDomain: string;
}) => {
  const act = useAction(pgpAction);
  const exporting = useAction(pgpAction);
  const [sign, setSign] = useState(signByDefault);
  const download = exporting.data?.ok ? exporting.data.download : undefined;

  useEffect(() => {
    if (download) {
      saveFile(download.filename, download.text);
    }
  }, [download]);

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-base">
          <span className="font-mono text-sm">
            {groupedFingerprint(own.fingerprint)}
          </span>
          <span className="text-subtle ml-auto text-xs">
            made <Timestamp iso={own.createdAt} relative={false} />
          </span>
        </div>
        <p className="text-muted text-sm">For {own.addresses.join(", ")}</p>
      </div>
      <p className="text-muted text-base">
        People find this key through your domain&rsquo;s Web Key Directory once{" "}
        <code className="text-fg">openpgpkey.{mailDomain}</code> points at the
        workspace, and on every message you sign.
      </p>
      <act.Form className="space-y-3">
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox
            name="on"
            checked={sign}
            onChange={(e) => setSign(e.currentTarget.checked)}
          />
          Sign every message I send
        </label>
        <p className="text-muted -mt-1 pl-6 text-sm">
          The composer still lets you switch it off for one message. People
          without OpenPGP see a small signature file attached.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            name="intent"
            value="sign-default"
            loading={act.state === "submitting"}
          >
            Save
          </Button>
          <Button
            onClick={() =>
              saveFile(
                `${own.addresses[0] ?? "public"}-public-key.asc`,
                own.publicKey
              )
            }
          >
            <Download className="h-3.5 w-3.5" />
            Public key
          </Button>
          <Button
            type="submit"
            name="intent"
            value="remove"
            className="text-red hover:text-red ml-auto"
            onClick={(e) => {
              // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
              const sure = confirm(
                "Remove your key? Mail encrypted to it can no longer be opened here, unless you import it again."
              );

              if (!sure) {
                e.preventDefault();
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove key
          </Button>
        </div>
      </act.Form>
      <Feedback result={act.data} error={act.error} />
      <exporting.Form className="border-line flex flex-wrap items-end gap-2 border-t pt-4">
        <Field
          label="Export the private key"
          hint="A copy for another mail client, or to keep: locked with this passphrase."
          className="min-w-56 flex-1"
        >
          <input
            name="passphrase"
            type="password"
            minLength={8}
            required
            autoComplete="new-password"
            className={inputClass}
          />
        </Field>
        <Button
          type="submit"
          name="intent"
          value="export"
          loading={exporting.state === "submitting"}
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      </exporting.Form>
      {exporting.data && !exporting.data.ok && (
        <Feedback result={exporting.data} error={exporting.error} />
      )}
    </div>
  );
};

const PeerRow = ({ peer }: { peer: PeerKeyView }) => {
  const act = useAction(pgpAction);

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span className="text-fg min-w-0 flex-1 truncate text-base">
        {peer.address}
      </span>
      <span
        className="text-subtle hidden font-mono text-xs sm:inline"
        title={groupedFingerprint(peer.fingerprint)}
      >
        {peer.fingerprint.slice(-16).toUpperCase()}
      </span>
      <Pill tone={peer.source === "imported" ? "accent" : "neutral"}>
        {SOURCE_LABELS[peer.source]}
      </Pill>
      <act.Form>
        <input type="hidden" name="address" value={peer.address} />
        <IconButton
          size="sm"
          type="submit"
          name="intent"
          value="remove-peer"
          label={`Remove the key for ${peer.address}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </act.Form>
    </li>
  );
};

const PeerKeys = ({ peers }: { peers: PeerKeyView[] }) => {
  const act = useAction(pgpAction);
  // A fresh form once a key was kept, so the field is empty for the next.
  const [round, setRound] = useState(0);
  const [seen, setSeen] = useState(act.data);

  if (seen !== act.data) {
    setSeen(act.data);

    if (act.data?.ok) {
      setRound((n) => n + 1);
    }
  }

  return (
    <Section title="OpenPGP keys of others">
      <div className="space-y-3 p-4">
        <p className="text-muted text-base">
          The keys you encrypt to and check signatures with. A colleague&rsquo;s
          key comes from the workspace; others come from their signed mail, from
          their domain, or from you.
        </p>
        <act.Form key={round} className="space-y-3">
          <Field label="Public key">
            <textarea
              name="publicKey"
              rows={4}
              required
              spellCheck={false}
              placeholder="The whole armored block, BEGIN line to END line"
              className={`${textareaClass} font-mono text-xs`}
            />
          </Field>
          <Button
            type="submit"
            name="intent"
            value="import-peer"
            loading={act.state === "submitting"}
          >
            <Upload className="h-3.5 w-3.5" />
            Import key
          </Button>
        </act.Form>
        <Feedback result={act.data} error={act.error} />
      </div>
      {peers.length > 0 && (
        <ul className="divide-line border-line divide-y border-t">
          {peers.map((p) => (
            <PeerRow key={p.address} peer={p} />
          ))}
        </ul>
      )}
    </Section>
  );
};

/**
 * Settings → Mail → OpenPGP: the person's own key (made here or imported, exported locked with a passphrase, signing
 * by default or not) and the keys of the people they write to.
 */
export const PgpSettings = ({ pgp }: { pgp: PgpSettingsData }) => (
  <>
    <Section title="OpenPGP">
      {pgp.own ? (
        <OwnKey
          own={pgp.own}
          signByDefault={pgp.signByDefault}
          mailDomain={pgp.mailDomain}
        />
      ) : (
        <NoKey />
      )}
    </Section>
    <PeerKeys peers={pgp.peers} />
  </>
);
