import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";
import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env, waitUntil } from "cloudflare:workers";
import { useState } from "react";
import { z } from "zod";

import { AuthShell, authCardClass } from "~/components/auth-shell";
import { Button, Field, Notice, inputClass } from "~/components/ui";
import { createDb } from "~/db";
import { stringOrNull } from "~/lib/guards";
import { requestPasswordReset } from "~/lib/recovery.server";

const searchSchema = z.object({ sent: z.coerce.string().optional() });

const getForgotPassword = createServerFn().handler(() => ({
  appName: env.APP_NAME,
  mailDomain: env.MAIL_DOMAIN,
  dev: import.meta.env.DEV,
}));

/** Sends the link, and logs and reports a failure: nobody waits for the answer, so it never reaches the person. */
const sendResetLink = async (request: Request, email: string) => {
  try {
    await requestPasswordReset(env, createDb(env.DB), email);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(
      JSON.stringify({
        event: "recovery.request-failed",
        error: failure.message,
      })
    );
    captureServerException(failure, { request });
  }
};

const ForgotPassword = () => {
  const { appName, mailDomain, dev } = Route.useLoaderData();
  const { sent } = Route.useSearch();
  const [submitting, setSubmitting] = useState(false);

  return (
    <AuthShell appName={appName} subtitle="Reset your password">
      {sent ? (
        <div className={authCardClass}>
          <Notice tone="success">
            If that account has a confirmed recovery address, a link to choose a
            new password is on its way there. It works once, for 30 minutes.
          </Notice>
          <p className="text-muted text-sm">
            Nothing after a few minutes? Check the spam folder of your recovery
            address. Without one, an admin can give you a one-time password.
          </p>
        </div>
      ) : (
        <form
          method="post"
          action="/forgot-password"
          onSubmit={() => setSubmitting(true)}
          className={authCardClass}
        >
          <p className="text-muted text-sm">
            We send a link to the recovery addresses you confirmed under
            Settings → Account.
          </p>
          <Field label="Email" hint={`Your ${mailDomain} address.`}>
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
          <Button
            type="submit"
            variant="primary"
            className="h-8 w-full"
            loading={submitting}
          >
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link to="/login" className="text-muted hover:text-fg">
          Back to sign-in
        </Link>
      </p>
    </AuthShell>
  );
};

export const Route = createFileRoute("/forgot-password")({
  validateSearch: searchSchema,
  loader: () => getForgotPassword(),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `Forgot your password · ${loaderData?.appName ?? "Workspace"}`,
      },
    ],
  }),
  server: {
    handlers: {
      // A classic form POST, like /login. The links go out after the response, so neither its answer nor the
      // time it takes says whether the address has an account.
      POST: async ({ request }) => {
        const form = await request.formData();
        // A field posted as a file counts as missing.
        waitUntil(
          sendResetLink(request, stringOrNull(form.get("email")) ?? "")
        );

        return new Response(null, {
          status: 303,
          headers: { Location: "/forgot-password?sent=1" },
        });
      },
    },
  },
  component: ForgotPassword,
});
