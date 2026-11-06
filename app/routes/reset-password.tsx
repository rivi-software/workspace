import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

import { AuthShell, authCardClass } from "~/components/auth-shell";
import { Button, Field, Notice, inputClass } from "~/components/ui";
import { createDb } from "~/db";
import { useAction } from "~/lib/action";
import { field, formData, formPost } from "~/lib/forms";
import { useLinkToken } from "~/lib/link-token";
import { RecoveryError, resetPassword } from "~/lib/recovery.server";

const getResetPassword = createServerFn().handler(() => ({
  appName: env.APP_NAME,
}));

/** The token comes from the link's fragment, so this is a server function the page calls, not a form post. */
const resetAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<{ error?: string }> => {
    try {
      await resetPassword(
        env,
        createDb(env.DB),
        {
          token: field(data, "token"),
          password: field(data, "password"),
          confirm: field(data, "confirm"),
        },
        getRequest().headers.get("cf-connecting-ip")
      );
    } catch (error) {
      if (error instanceof RecoveryError) {
        return { error: error.message };
      }

      throw error;
    }

    throw redirect({ href: "/login?reset=1" });
  });

const ResetPassword = () => {
  const { appName } = Route.useLoaderData();
  const token = useLinkToken();
  const act = useAction(resetAction, { token: token ?? "" });
  const message = act.data?.error ?? act.error;

  return (
    <AuthShell appName={appName} subtitle="Choose a new password">
      {token === "" ? (
        <div className={authCardClass}>
          <Notice tone="error">
            This page opens from the link in a reset mail. Ask for a new mail
            and open its link.
          </Notice>
        </div>
      ) : (
        <act.Form className={authCardClass}>
          <noscript>
            <Notice tone="error">
              This page needs JavaScript to read the link from your mail.
            </Notice>
          </noscript>
          <Field label="New password" hint="At least 12 characters.">
            <input
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              autoFocus
              className={`${inputClass} h-8`}
            />
          </Field>
          <Field label="Confirm">
            <input
              name="confirm"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              className={`${inputClass} h-8`}
            />
          </Field>
          {message && <Notice tone="error">{message}</Notice>}
          <p className="text-muted text-sm">
            Every browser and device signed in to your account is signed out.
          </p>
          <Button
            type="submit"
            variant="primary"
            className="h-8 w-full"
            disabled={!token}
            loading={act.state === "submitting"}
          >
            Change password
          </Button>
        </act.Form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link to="/forgot-password" className="text-muted hover:text-fg">
          Send a new link
        </Link>
      </p>
    </AuthShell>
  );
};

export const Route = createFileRoute("/reset-password")({
  loader: () => getResetPassword(),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `Choose a new password · ${loaderData?.appName ?? "Workspace"}`,
      },
    ],
  }),
  component: ResetPassword,
});
