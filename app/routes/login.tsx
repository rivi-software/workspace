import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { AuthShell, authCardClass } from "~/components/auth-shell";
import { Button, Field, Notice, inputClass } from "~/components/ui";
import { createDb } from "~/db";
import {
  authClient,
  passkeyProblem,
  passkeysSupported,
} from "~/lib/auth-client";
import { getSessionUser } from "~/lib/auth.server";
import { stringOrNull } from "~/lib/guards";
import { passwordSignIn, safeNext } from "~/lib/sign-in.server";

const searchSchema = z.object({
  next: z.string().optional(),
  error: z.enum(["invalid", "throttled", "inactive", "two-factor"]).optional(),
  // The person just chose a new password through a reset link (`/reset-password`).
  reset: z.coerce.string().optional(),
});

const getLogin = createServerFn()
  .validator((data: { next?: string }) => data)
  .handler(async ({ data }) => {
    const db = createDb(env.DB);
    const request = getRequest();
    const current = await getSessionUser(request, env, db);

    if (current) {
      throw redirect({
        href: safeNext(data.next ?? "/mail", new URL(request.url).origin),
      });
    }

    // The seed account hint and prefilled address only exist in local development.
    return {
      appName: env.APP_NAME,
      mailDomain: env.MAIL_DOMAIN,
      dev: import.meta.env.DEV,
    };
  });

/** What went wrong with a sign-in, by the `error` the form's post sends back; anything else is a wrong pair. */
const SIGN_IN_ERRORS: ReadonlyMap<string, string> = new Map([
  ["throttled", "Too many failed attempts. Wait 15 minutes and try again."],
  [
    "inactive",
    "This account has been deactivated. Ask an admin to reactivate it.",
  ],
  [
    "two-factor",
    "The code did not confirm the sign-in, or it took too long. Sign in again.",
  ],
]);

const signInError = (error: string | undefined): string | null => {
  if (!error) {
    return null;
  }

  return (
    SIGN_IN_ERRORS.get(error) ??
    "That address and password don't match. Check both and try again."
  );
};

/**
 * Sign in with a passkey (Touch ID, Windows Hello, a phone or a security key): the browser's prompt through Better
 * Auth's passkey plugin, then the page loads whole on the new session. The button waits for hydration, since only
 * the browser knows whether it can make the prompt; a browser that cannot keeps the password form alone.
 */
const PasskeyButton = ({ next }: { next: string }) => {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- whether passkeys work is known only in the browser, after hydration
    setSupported(passkeysSupported());
  }, []);

  if (!supported) {
    return null;
  }

  const signIn = async () => {
    setProblem(null);
    setBusy(true);

    const result = await authClient.signIn.passkey();

    if (result?.error) {
      const { error } = result;
      setProblem(
        "code" in error && error.code
          ? passkeyProblem(error.code)
          : (error.message ??
              "The passkey did not sign you in. Try again, or use your password.")
      );
      setBusy(false);

      return;
    }

    // A whole load, so the server reads the new session for the page it renders.
    window.location.assign(next);
  };

  return (
    <div className="mt-3 space-y-2">
      <Button
        className="h-8 w-full"
        loading={busy}
        onClick={() => {
          void signIn();
        }}
      >
        {!busy && <KeyRound className="h-3.5 w-3.5" />}
        Sign in with a passkey
      </Button>
      {problem && <Notice tone="error">{problem}</Notice>}
    </div>
  );
};

const Login = () => {
  const { appName, mailDomain, dev } = Route.useLoaderData();
  const { next, error, reset } = Route.useSearch();
  const errorText = signInError(error);
  const [submitting, setSubmitting] = useState(false);
  const target = next ?? "/mail";

  return (
    <AuthShell
      appName={appName}
      subtitle={`Sign in with your ${mailDomain} address`}
    >
      <form
        method="post"
        action="/login"
        onSubmit={() => setSubmitting(true)}
        className={authCardClass}
      >
        <input type="hidden" name="next" value={target} />
        <Field label="Email">
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            autoFocus
            className={`${inputClass} h-8`}
            defaultValue={dev ? "admin@example.com" : undefined}
          />
        </Field>
        <Field label="Password">
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className={`${inputClass} h-8`}
          />
        </Field>
        {reset && !errorText && (
          <Notice tone="success">
            Your password is changed and every session is signed out. Sign in
            with the new password.
          </Notice>
        )}
        {errorText && <Notice tone="error">{errorText}</Notice>}
        <Button
          type="submit"
          variant="primary"
          className="h-8 w-full"
          loading={submitting}
        >
          Sign in
        </Button>
      </form>
      <PasskeyButton next={target} />
      <p className="mt-4 text-center text-sm">
        <Link to="/forgot-password" className="text-muted hover:text-fg">
          Forgot your password?
        </Link>
      </p>
      {dev && (
        <p className="text-subtle mt-4 text-center text-xs">
          Local seed account: admin@example.com / password
        </p>
      )}
    </AuthShell>
  );
};

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ next: search.next }),
  loader: ({ deps }) => getLogin({ data: deps }),
  head: ({ loaderData }) => ({
    meta: [{ title: `Sign in · ${loaderData?.appName ?? "Workspace"}` }],
  }),
  server: {
    handlers: {
      // A classic form POST: signing in works before (or without) JavaScript and from scripts.
      POST: async ({ request }) => {
        const form = await request.formData();

        return passwordSignIn(request, env, createDb(env.DB), {
          // A field posted as a file counts as missing.
          email: stringOrNull(form.get("email")) ?? "",
          password: stringOrNull(form.get("password")) ?? "",
          next: stringOrNull(form.get("next")) ?? "/mail",
        });
      },
    },
  },
  component: Login,
});
