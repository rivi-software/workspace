/**
 * Settings → Account → Two-factor authentication: the authenticator app a password sign-in asks a code from
 * (Better Auth's two-factor plugin, TOTP), set up, given new backup codes or turned off here. Each step runs in
 * the browser through `authClient` with the current password; the route's loader says whether it is on.
 */
import { useHydrated, useRouter } from "@tanstack/react-router";
import { Copy, ShieldCheck, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { encode } from "uqr";

import { authClient } from "~/lib/auth-client";

import { useToast } from "./toast";
import { Button, Field, Notice, Section, inputClass } from "./ui";

/** What to say for a Better Auth error here, by its code; the server's own words otherwise. */
const problemOf = (error: { code?: string; message?: string }): string => {
  if (error.code === "INVALID_PASSWORD") {
    return "The current password is not right.";
  }

  if (error.code === "INVALID_CODE") {
    return "That code is not right. Try the next one.";
  }

  return error.message ?? "That did not go through. Try again.";
};

/** The dark modules of a QR code as one path: a unit square at each. */
const qrPath = (data: boolean[][]): string => {
  const squares: string[] = [];

  for (const [y, row] of data.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) {
        squares.push(`M${x} ${y}h1v1h-1z`);
      }
    }
  }

  return squares.join("");
};

/** The otpauth URI as the QR code an authenticator app scans; drawn here, so nothing is injected as markup. */
const QrCode = ({ value }: { value: string }) => {
  const qr = useMemo(() => encode(value, { border: 2 }), [value]);

  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={176}
      height={176}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an inline SVG drawn from the code's modules is an image to a screen reader; `<img>` would need the markup serialised into a data URL first
      role="img"
      aria-label="QR code for your authenticator app"
      className="shrink-0 rounded-md bg-white [shape-rendering:crispEdges]"
    >
      <path d={qrPath(qr.data)} fill="#000" />
    </svg>
  );
};

/** The secret of an otpauth URI, for an app that takes it typed in rather than scanned. */
const secretOf = (totpURI: string): string =>
  new URL(totpURI).searchParams.get("secret") ?? "";

const BackupCodes = ({
  codes,
  replaced,
}: {
  codes: string[];
  /** New codes for a person who had some: the old ones are void. */
  replaced?: boolean;
}) => {
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.show({ message: "Backup codes copied." });
    } catch {
      toast.show({ message: "The codes could not be copied.", tone: "error" });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-muted text-sm font-medium">Backup codes</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            void copy();
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
      </div>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm select-all sm:grid-cols-3">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <p className="text-subtle text-xs">
        Save these somewhere safe: each works once, when you cannot reach your
        authenticator app.
        {replaced && " The codes you had before no longer work."}
      </p>
    </div>
  );
};

/**
 * The current password, which every change here needs. `onSubmit` answers what went wrong, or null when the change
 * went through (and this form has gone with it).
 */
const PasswordForm = ({
  action,
  hint,
  onSubmit,
  onCancel,
}: {
  action: string;
  hint: string;
  onSubmit: (password: string) => Promise<string | null>;
  onCancel: () => void;
}) => {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    setProblem(null);
    setBusy(true);
    setProblem(await onSubmit(password));
    setBusy(false);
  };

  return (
    <form
      className="bg-sidebar space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Current password" hint={hint} className="sm:max-w-xs">
        <input
          name="current"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          autoComplete="current-password"
          required
          autoFocus
          className={inputClass}
        />
      </Field>
      {problem && <Notice tone="error">{problem}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={busy}>
          {action}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
};

interface Shared {
  hydrated: boolean;
  /** What the last change said, shown until dismissed. */
  notice: string | null;
  onNotice: (notice: string | null) => void;
}

const SectionNotice = ({
  notice,
  onNotice,
}: Pick<Shared, "notice" | "onNotice">) =>
  notice && (
    <div className="p-4">
      <Notice tone="success" onDismiss={() => onNotice(null)}>
        {notice}
      </Notice>
    </div>
  );

/** Setting it up: the password, then the QR code, the backup codes and a first code to check the app by. */
const TwoFactorOff = ({ hydrated, notice, onNotice }: Shared) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [setup, setSetup] = useState<{
    totpURI: string;
    backupCodes: string[];
  } | null>(null);

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const enable = async (password: string): Promise<string | null> => {
    const { data, error } = await authClient.twoFactor.enable({ password });

    if (error) {
      return problemOf(error);
    }

    // Codes by mail are not set up on the plugin, so the answer is always the app's.
    if (data.method !== "totp") {
      return "That did not go through. Try again.";
    }

    setSetup({ totpURI: data.totpURI, backupCodes: data.backupCodes });

    return null;
  };

  const verify = async () => {
    setProblem(null);
    setBusy(true);

    const { error } = await authClient.twoFactor.verifyTotp({
      code: code.trim(),
    });

    if (error) {
      setProblem(problemOf(error));
      setBusy(false);

      return;
    }

    // The loader's answer turns this into the section for a person with it on.
    await router.invalidate();
    onNotice("Two-factor authentication is on.");
  };

  return (
    <Section
      title="Two-factor authentication"
      actions={
        hydrated &&
        !setup && (
          <Button
            size="sm"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Set up
          </Button>
        )
      }
    >
      <div className="divide-line divide-y">
        <p className="text-muted px-4 py-3 text-sm">
          Ask for a code from an authenticator app (1Password, Google
          Authenticator, Authy…) after every password sign-in.
        </p>
        <SectionNotice notice={notice} onNotice={onNotice} />
        {open && !setup && (
          <PasswordForm
            action="Continue"
            hint="To make sure it is you setting this up."
            onSubmit={enable}
            onCancel={() => setOpen(false)}
          />
        )}
        {setup && (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap gap-4">
              <QrCode value={setup.totpURI} />
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p className="text-muted">
                  Scan this with your authenticator app, or type the secret into
                  it:
                </p>
                <code className="bg-hover text-fg block rounded px-2 py-1 font-mono text-xs break-all select-all">
                  {secretOf(setup.totpURI)}
                </code>
              </div>
            </div>
            <BackupCodes codes={setup.backupCodes} />
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <Field
                label="Code"
                hint="The six digits the app shows now, to check it is set up right."
                className="sm:max-w-xs"
              >
                <input
                  name="code"
                  value={code}
                  onChange={(e) => setCode(e.currentTarget.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  className={`${inputClass} font-mono`}
                />
              </Field>
              {problem && <Notice tone="error">{problem}</Notice>}
              <div className="flex gap-2">
                <Button type="submit" variant="primary" loading={busy}>
                  Turn on
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSetup(null);
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
    </Section>
  );
};

/** With it on: new backup codes, or off again, each with the password. */
const TwoFactorOn = ({ hydrated, notice, onNotice }: Shared) => {
  const router = useRouter();
  const [open, setOpen] = useState<"codes" | "off" | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const toggle = (panel: "codes" | "off") => {
    setCodes(null);
    setOpen((o) => (o === panel ? null : panel));
  };

  const regenerate = async (password: string): Promise<string | null> => {
    const { data, error } = await authClient.twoFactor.generateBackupCodes({
      password,
    });

    if (error) {
      return problemOf(error);
    }

    setCodes(data.backupCodes);

    return null;
  };

  const disable = async (password: string): Promise<string | null> => {
    const { error } = await authClient.twoFactor.disable({ password });

    if (error) {
      return problemOf(error);
    }

    await router.invalidate();
    onNotice("Two-factor authentication is off.");

    return null;
  };

  return (
    <Section
      title="Two-factor authentication"
      actions={
        hydrated && (
          <>
            <Button
              size="sm"
              onClick={() => toggle("codes")}
              aria-expanded={open === "codes"}
            >
              New backup codes
            </Button>
            <Button
              size="sm"
              onClick={() => toggle("off")}
              aria-expanded={open === "off"}
            >
              <ShieldOff className="h-3.5 w-3.5" />
              Turn off
            </Button>
          </>
        )
      }
    >
      <div className="divide-line divide-y">
        <p className="text-muted px-4 py-3 text-sm">
          Every password sign-in asks for a code from your authenticator app; a
          passkey sign-in does not.
        </p>
        <SectionNotice notice={notice} onNotice={onNotice} />
        {open === "codes" &&
          (codes ? (
            <div className="p-4">
              <BackupCodes codes={codes} replaced />
            </div>
          ) : (
            <PasswordForm
              action="New backup codes"
              hint="New codes replace the ones you saved."
              onSubmit={regenerate}
              onCancel={() => setOpen(null)}
            />
          ))}
        {open === "off" && (
          <PasswordForm
            action="Turn off"
            hint="Your password alone signs you in again."
            onSubmit={disable}
            onCancel={() => setOpen(null)}
          />
        )}
      </div>
    </Section>
  );
};

/** Whether a password sign-in asks for an authenticator app's code, and the ways to change that. */
export const TwoFactor = ({ enabled }: { enabled: boolean }) => {
  // Every step needs the browser (`authClient`): the server renders the words alone.
  const hydrated = useHydrated();
  // Kept above the two states: the one that made a change is gone once the loader answers.
  const [notice, setNotice] = useState<string | null>(null);
  const shared = { hydrated, notice, onNotice: setNotice };

  return enabled ? <TwoFactorOn {...shared} /> : <TwoFactorOff {...shared} />;
};
