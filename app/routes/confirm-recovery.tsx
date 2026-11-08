import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { useEffect, useRef } from "react";

import { AuthShell, authCardClass } from "~/components/auth-shell";
import { Notice } from "~/components/ui";
import { createDb } from "~/db";
import { useAction } from "~/lib/action";
import { formData, formPost } from "~/lib/forms";
import { field } from "~/lib/guards";
import { useLinkToken } from "~/lib/link-token";
import { confirmRecoveryAddress } from "~/lib/recovery.server";

const getConfirmRecovery = createServerFn().handler(() => ({
  appName: env.APP_NAME,
}));

const confirmAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<{ address?: string; error?: string }> => {
    const confirmed = await confirmRecoveryAddress(
      createDb(env.DB),
      field(data, "token")
    );

    return (
      confirmed ?? {
        error:
          "This link has expired or was already used. Send a new one from Settings → Account, then open the latest mail.",
      }
    );
  });

const Outcome = ({
  address,
  error,
}: {
  address: string | undefined;
  error: string | null | undefined;
}) => {
  if (address) {
    return (
      <Notice tone="success">
        <strong>{address}</strong> is confirmed. If you forget your password, a
        link to choose a new one can be sent there.
      </Notice>
    );
  }

  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }

  return <p className="text-muted text-sm">Confirming…</p>;
};

const ConfirmRecovery = () => {
  const { appName } = Route.useLoaderData();
  const token = useLinkToken();
  const act = useAction(confirmAction);
  const { submit } = act;
  const sent = useRef(false);
  useEffect(() => {
    if (!token || sent.current) {
      return;
    }

    sent.current = true;
    void submit({ token });
  }, [token, submit]);

  const error =
    token === ""
      ? "This page opens from the link in a confirmation mail."
      : (act.data?.error ?? act.error);

  return (
    <AuthShell appName={appName} subtitle="Confirm a recovery address">
      <div className={authCardClass}>
        <Outcome address={act.data?.address} error={error} />
        <noscript>
          <Notice tone="error">
            This page needs JavaScript to read the link from your mail.
          </Notice>
        </noscript>
      </div>
      <p className="mt-4 text-center text-sm">
        <Link to="/settings" className="text-muted hover:text-fg">
          Open Settings
        </Link>
      </p>
    </AuthShell>
  );
};

/**
 * Where the link mailed to a new recovery address lands. Opening it is the confirmation: the page sends the
 * token from the fragment as soon as it has read it. No sign-in is needed, as the link may open on another device.
 */
export const Route = createFileRoute("/confirm-recovery")({
  loader: () => getConfirmRecovery(),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `Confirm a recovery address · ${loaderData?.appName ?? "Workspace"}`,
      },
    ],
  }),
  component: ConfirmRecovery,
});
