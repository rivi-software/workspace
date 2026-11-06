/**
 * Settings → Account → Passkeys: what signs the person in without a password (Better Auth's passkey plugin, on
 * WebAuthn). Only the browser can make the prompt that adds one, so adding and removing go through `authClient`
 * here, and the list comes back through the route's loader.
 */
import { useHydrated, useRouter } from "@tanstack/react-router";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  authClient,
  passkeyProblem,
  passkeysSupported,
} from "~/lib/auth-client";

import {
  Button,
  Field,
  Notice,
  Pill,
  Section,
  Timestamp,
  inputClass,
} from "./ui";

export interface PasskeyRow {
  id: string;
  name: string;
  createdAt: string;
  /** Synced to the person's other devices (iCloud Keychain, Google Password Manager, a password manager). */
  backedUp: boolean;
}

/** Its own component, so closing it forgets the name; it closes once the passkey is added. */
const AddPasskey = ({ onDone }: { onDone: () => void }) => {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async () => {
    // The browser's prompt is asked for before anything else: Safari opens it only straight from the submit.
    const trimmed = name.trim();

    const { error } = await authClient.passkey.addPasskey(
      trimmed ? { name: trimmed } : {}
    );

    if (error) {
      // A prompt that failed comes with a code; a server's answer may have only its words.
      const code = "code" in error ? error.code : "";

      setProblem(
        code
          ? passkeyProblem(code)
          : (error.message ?? "The passkey was not added. Try again.")
      );
      setBusy(false);

      return;
    }

    await router.invalidate();
    onDone();
  };

  return (
    <form
      className="bg-sidebar space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setProblem(null);
        setBusy(true);
        void add();
      }}
    >
      <Field
        label="Name"
        hint="The device or key it lives on; only you see it."
      >
        <input
          name="name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={60}
          autoFocus
          placeholder="MacBook Touch ID"
          className={inputClass}
        />
      </Field>
      {problem && <Notice tone="error">{problem}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={busy}>
          Add passkey
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
};

const PasskeyItem = ({ passkey: p }: { passkey: PasskeyRow }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async () => {
    setProblem(null);
    setBusy(true);
    const { error } = await authClient.passkey.deletePasskey({ id: p.id });

    if (error) {
      setProblem(error.message ?? "The passkey was not removed. Try again.");
      setBusy(false);

      return;
    }

    // The row goes with the loader's next answer.
    await router.invalidate();
  };

  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="text-muted h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate text-base font-medium">{p.name}</span>
        {p.backedUp && <Pill tone="accent">Synced</Pill>}
        <Button
          size="sm"
          variant="ghost"
          className="hover:text-red ml-auto"
          loading={busy}
          onClick={() => {
            if (
              // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
              confirm(
                `Remove the passkey “${p.name}”? It no longer signs you in.`
              )
            ) {
              void remove();
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </Button>
      </div>
      <div className="text-subtle pl-6 text-xs">
        Added <Timestamp iso={p.createdAt} relative={false} />
      </div>
      {problem && <Notice tone="error">{problem}</Notice>}
    </li>
  );
};

/** The person's passkeys, and the browser's prompt to add one (at most `max`). */
export const Passkeys = ({
  passkeys,
  max,
}: {
  passkeys: PasskeyRow[];
  max: number;
}) => {
  // Whether this browser can make one is known only once it runs: the server renders the list alone.
  const hydrated = useHydrated();
  const supported = hydrated && passkeysSupported();
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="Passkeys"
      actions={
        supported &&
        passkeys.length < max && (
          <Button
            size="sm"
            onClick={() => setAdding((a) => !a)}
            aria-expanded={adding}
          >
            <Plus className="h-3.5 w-3.5" />
            Add passkey
          </Button>
        )
      }
    >
      <div className="divide-line divide-y">
        {adding && supported && <AddPasskey onDone={() => setAdding(false)} />}
        {passkeys.length > 0 ? (
          <ul className="divide-line divide-y">
            {passkeys.map((p) => (
              <PasskeyItem key={p.id} passkey={p} />
            ))}
          </ul>
        ) : (
          !adding && (
            <div className="text-muted p-6 text-center text-base">
              <KeyRound className="mx-auto mb-2 h-4 w-4" />
              Sign in without your password: Touch ID, Windows Hello, your phone
              or a security key.
            </div>
          )
        )}
        {hydrated && !supported && (
          <p className="text-subtle px-4 py-3 text-xs">
            This browser cannot make a passkey. Add one from a browser that can,
            and it signs you in there.
          </p>
        )}
      </div>
    </Section>
  );
};
