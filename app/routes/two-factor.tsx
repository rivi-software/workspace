import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { useState } from "react";
import { z } from "zod";

import { AuthShell, authCardClass } from "~/components/auth-shell";
import { Button, Field, Notice, inputClass } from "~/components/ui";
import { secondFactorSignIn } from "~/lib/sign-in.server";

const searchSchema = z.object({
  next: z.string().optional(),
  error: z.enum(["two-factor", "throttled"]).optional(),
});

const getTwoFactor = createServerFn().handler(() => ({
  appName: env.APP_NAME,
}));

const ERRORS: Record<"two-factor" | "throttled", string> = {
  "two-factor": "That code is not right, or it has expired. Try the next one.",
  throttled: "Too many wrong codes. Wait 15 minutes and sign in again.",
};

/**
 * The second step of a password sign-in for a person with an authenticator app: the six-digit code, or one of the
 * backup codes they kept. The password is right already; Better Auth holds it in a cookie on this host until the
 * code confirms it (`secondFactorSignIn`).
 */
const TwoFactor = () => {
  const { appName } = Route.useLoaderData();
  const { next, error } = Route.useSearch();
  const [backup, setBackup] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  return (
    <AuthShell appName={appName} subtitle="Confirm it's you">
      <form
        method="post"
        // The route's own path, written out: the server module that names it never reaches the client bundle.
        action="/two-factor"
        onSubmit={() => setSubmitting(true)}
        className={authCardClass}
      >
        <input type="hidden" name="next" value={next ?? "/mail"} />
        <input type="hidden" name="backup" value={backup ? "1" : ""} />
        <p className="text-base">
          {backup
            ? "Enter one of the backup codes you saved when you set up your authenticator app. Each works once."
            : "Enter the code your authenticator app shows for this workspace."}
        </p>
        <Field label={backup ? "Backup code" : "Code"}>
          <input
            key={backup ? "backup" : "code"}
            name="code"
            inputMode={backup ? "text" : "numeric"}
            autoComplete="one-time-code"
            required
            autoFocus
            className={`${inputClass} h-8 font-mono`}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="trust" value="1" />
          Don&apos;t ask again on this browser for 30 days
        </label>
        {error && <Notice tone="error">{ERRORS[error]}</Notice>}
        <Button
          type="submit"
          variant="primary"
          className="h-8 w-full"
          loading={submitting}
        >
          Continue
        </Button>
      </form>
      <p className="mt-4 text-center text-sm">
        <button
          type="button"
          className="text-muted hover:text-fg"
          onClick={() => setBackup((b) => !b)}
        >
          {backup ? "Use the authenticator app instead" : "Use a backup code"}
        </button>
        {" · "}
        <Link to="/login" className="text-muted hover:text-fg">
          Sign in again
        </Link>
      </p>
    </AuthShell>
  );
};

export const Route = createFileRoute("/two-factor")({
  validateSearch: searchSchema,
  loader: () => getTwoFactor(),
  head: ({ loaderData }) => ({
    meta: [
      { title: `Confirm it's you · ${loaderData?.appName ?? "Workspace"}` },
    ],
  }),
  server: {
    handlers: {
      // A classic form POST, as /login: the code goes to Better Auth with the two-factor cookie the sign-in set.
      POST: async ({ request }) => {
        const form = await request.formData();

        return secondFactorSignIn(request, env, {
          code: String(form.get("code") ?? ""),
          backup: String(form.get("backup") ?? "") === "1",
          trust: String(form.get("trust") ?? "") === "1",
          next: String(form.get("next") ?? "/mail"),
        });
      },
    },
  },
  component: TwoFactor,
});
