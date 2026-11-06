import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { CheckCircle2, Download, FileSignature, Link2Off } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { AuthShell, authCardClass } from "~/components/auth-shell";
import { RiviMark } from "~/components/brand";
import { PdfPages } from "~/components/drive/pdf-pages";
import { SignatureDialog } from "~/components/drive/signature-pad";
import { FillLayer } from "~/components/drive/signing-fields";
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Notice,
  Timestamp,
  buttonClass,
  inputClass,
  textareaClass,
} from "~/components/ui";
import { createDb } from "~/db";
import { customerDocumentPath, customerSigningPath } from "~/lib/drive/signing";
import type { SigningValues } from "~/lib/drive/signing";
import { customerPage, customerPost } from "~/lib/drive/signing.server";
import type { CustomerPage } from "~/lib/drive/signing.server";
import { defined, isJsonObject, stringOrNull } from "~/lib/guards";

// What a code form's post sends back (`customerPost`): the step to show and what went wrong.
const searchSchema = z.object({
  step: z.coerce.string().optional(),
  error: z.coerce.string().optional(),
});

// Anyone can call this without a session: whatever arrives is read as a string, or not at all.
const getSigning = createServerFn()
  .validator((d: { token: string }) => ({
    token: stringOrNull(d?.token) ?? "",
  }))
  .handler(
    async ({ data }): Promise<{ appName: string; page: CustomerPage }> => {
      const page = await customerPage(
        env,
        createDb(env.DB),
        getRequest(),
        data.token
      );

      if (!page) {
        throw notFound();
      }

      return { appName: env.APP_NAME, page };
    }
  );

const Shell = ({
  appName,
  children,
}: {
  appName: string;
  children: ReactNode;
}) => (
  <AuthShell appName={appName} subtitle="A request for your signature">
    {children}
  </AuthShell>
);

/** What this page's script posts: signing, with the values and the signature, or declining, with a reason. */
type SigningPost =
  | {
      intent: "sign";
      values: SigningValues;
      signature: string | null;
      agree: boolean;
    }
  | { intent: "decline"; reason: string };

/** Post to this page from its script, and load it again once it took. */
const post = async (
  token: string,
  body: SigningPost
): Promise<string | null> => {
  try {
    const res = await fetch(customerSigningPath(token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });

    const answer = await res.json();

    if (isJsonObject(answer) && answer.ok) {
      window.location.replace(customerSigningPath(token));

      return null;
    }

    const failure = isJsonObject(answer) ? stringOrNull(answer.error) : null;

    return failure ?? "That did not work. Try again.";
  } catch {
    return "That did not reach us. Check your connection and try again.";
  }
};

/** Declining, with an optional reason: the request then ends. */
const DeclineDialog = ({
  token,
  from,
  open,
  onClose,
}: {
  token: string;
  from: string;
  open: boolean;
  onClose: () => void;
}) => {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onClose={onClose} title="Decline to sign">
      <div className="space-y-3">
        <p className="text-muted text-base">
          {from} hears that you declined, with your reason. The request then
          ends.
        </p>
        <Field label="Your reason (optional)">
          <textarea
            className={textareaClass}
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Back</Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(await post(token, { intent: "decline", reason }));
              setBusy(false);
            }}
          >
            Decline
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

const SignView = ({
  token,
  appName,
  page,
}: {
  token: string;
  appName: string;
  page: SignPage;
}) => {
  const [values, setValues] = useState<SigningValues>({});
  const [signature, setSignature] = useState<string | null>(null);

  const [dialog, setDialog] = useState<
    "signature" | "finish" | "decline" | null
  >(null);

  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = useMemo(
    () => page.fields.filter((f) => f.party === "customer"),
    [page.fields]
  );

  const missing = mine.filter((f) => {
    if (f.kind === "signature") {
      return !signature;
    }

    if (f.kind === "date") {
      return false;
    }

    if (!f.required) {
      return false;
    }

    return f.kind === "checkbox"
      ? values[f.id] !== "yes"
      : !values[f.id]?.trim();
  });

  const send = async (body: SigningPost) => {
    setBusy(true);
    setError(await post(token, body));
    setBusy(false);
  };

  return (
    <div className="bg-sidebar flex min-h-dvh flex-col">
      <header className="border-line bg-bg sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        <RiviMark className="text-[22px]" />
        <span className="hidden text-base font-medium sm:inline">
          {appName}
        </span>
        <span className="text-muted min-w-0 truncate text-base">
          <span className="text-fg">{page.name}</span> · from {page.from}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-subtle hidden text-sm md:inline">
            {missing.length ? `${missing.length} to fill in` : "Ready to sign"}
          </span>
          <Button onClick={() => setDialog("decline")}>Decline</Button>
          <Button
            variant="primary"
            onClick={() => {
              setError(null);

              if (missing.length) {
                const first = defined(missing[0], "the first item");

                if (first.kind === "signature") {
                  setDialog("signature");
                } else {
                  setError(`Fill in "${first.label}" first.`);
                }

                return;
              }

              setDialog("finish");
            }}
          >
            Sign
          </Button>
        </div>
      </header>
      <main className="flex-1 px-4 py-6">
        <div className="mx-auto mb-4 w-full max-w-[880px] space-y-3">
          <p className="text-muted text-base">
            Hello {page.customerName}. Fill in the{" "}
            <span className="text-fg rounded-[3px] bg-sky-500/15 px-1">
              blue fields
            </span>{" "}
            and sign where it says so. The green ones are {appName}&apos;s, who
            signs after you. Open until{" "}
            <Timestamp iso={page.expiresAt} relative={false} />.
          </p>
          {page.message && (
            <blockquote className="border-line bg-elevated text-fg rounded-md border px-3 py-2 text-base whitespace-pre-wrap">
              {page.message}
            </blockquote>
          )}
          {error && (
            <Notice tone="error" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
        </div>
        <PdfPages
          src={customerDocumentPath(token)}
          renderOverlay={(i, shown) => (
            <FillLayer
              page={i}
              shown={shown}
              fields={page.fields}
              party="customer"
              values={page.values}
              mine={values}
              signature={signature}
              onValue={(id, v) => setValues((old) => ({ ...old, [id]: v }))}
              onSign={() => setDialog("signature")}
            />
          )}
        />
      </main>

      <SignatureDialog
        open={dialog === "signature"}
        name={page.customerName}
        onClose={() => setDialog(null)}
        onAdopt={(png) => {
          setSignature(png);
          setDialog(null);
        }}
        note="This signature goes on every place this document asks for yours."
      />
      <Dialog
        open={dialog === "finish"}
        onClose={() => setDialog(null)}
        title="Sign the document"
      >
        <div className="space-y-3">
          <label className="text-fg flex items-start gap-2.5 text-base">
            <Checkbox
              className="mt-0.5"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            <span>
              I have read &ldquo;{page.name}&rdquo;, and I agree to sign it
              electronically. My electronic signature is as binding as my
              handwritten one.
            </span>
          </label>
          <p className="text-muted text-sm">
            We record when you sign, from which address and browser, and add it
            to a certificate at the end of the signed copy.
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDialog(null)}>Back</Button>
            <Button
              variant="primary"
              disabled={!agree}
              loading={busy}
              onClick={() => {
                send({ intent: "sign", values, signature, agree });
              }}
            >
              Sign
            </Button>
          </div>
        </div>
      </Dialog>
      <DeclineDialog
        token={token}
        from={page.from}
        open={dialog === "decline"}
        onClose={() => setDialog(null)}
      />
    </div>
  );
};

const endedTitle = (
  why: Extract<CustomerPage, { state: "ended" }>["why"]
): string => {
  if (why === "declined") {
    return "This request was declined";
  }

  return why === "cancelled"
    ? "This request was cancelled"
    : "This request has expired";
};

const SigningPageView = () => {
  const { appName, page } = Route.useLoaderData();
  const { token } = Route.useParams();
  const { step, error } = Route.useSearch();

  if (page.state === "throttled") {
    return (
      <Shell appName={appName}>
        <Notice tone="error">
          Too many attempts from here. Wait 15 minutes, then try again.
        </Notice>
      </Shell>
    );
  }

  if (page.state === "ended") {
    return (
      <Shell appName={appName}>
        <div className={authCardClass}>
          <div className="text-md flex items-center gap-2 font-medium">
            <Link2Off className="text-subtle h-4 w-4" />
            {endedTitle(page.why)}
          </div>
          <p className="text-muted text-base">
            &ldquo;{page.name}&rdquo; can no longer be signed here. Ask{" "}
            {page.from} for a new request if it still needs your signature.
          </p>
        </div>
      </Shell>
    );
  }

  if (page.state === "confirm") {
    return (
      <Shell appName={appName}>
        {step === "code" ? (
          <div className={authCardClass}>
            <form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="code" />
              <p className="text-muted text-base">
                We sent a code to {page.email}. It works for 10 minutes.
              </p>
              {error === "code" && (
                <Notice tone="error">
                  That code is not right, or it has expired.
                </Notice>
              )}
              {error === "codes" && (
                <Notice tone="error">
                  Too many codes in the last hour. Use the last one, or wait a
                  while.
                </Notice>
              )}
              <Field label="Code">
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  maxLength={8}
                  className={inputClass}
                  autoFocus
                  required
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                className="w-full justify-center"
              >
                Confirm
              </Button>
            </form>
            <form method="post">
              <input type="hidden" name="intent" value="send-code" />
              <button
                type="submit"
                className="text-accent text-sm hover:underline"
              >
                Send a new code
              </button>
            </form>
          </div>
        ) : (
          <form method="post" className={authCardClass}>
            <input type="hidden" name="intent" value="send-code" />
            <div className="text-md flex items-center gap-2 font-medium">
              <FileSignature className="text-subtle h-4 w-4" />
              {page.name}
            </div>
            <p className="text-muted text-base">
              {page.from} of {appName} asks you to sign this document. To open
              it, confirm it is you: we mail a code to {page.email}.
            </p>
            {error === "throttled" && (
              <Notice tone="error">
                Too many attempts from here. Wait 15 minutes.
              </Notice>
            )}
            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
            >
              Email me a code
            </Button>
          </form>
        )}
      </Shell>
    );
  }

  if (page.state === "signed") {
    return (
      <Shell appName={appName}>
        <div className={authCardClass}>
          <div className="text-md flex items-center gap-2 font-medium">
            <CheckCircle2 className="text-accent h-4 w-4" />
            You signed &ldquo;{page.name}&rdquo;
          </div>
          <p className="text-muted text-base">
            You signed on <Timestamp iso={page.signedAt} relative={false} />.{" "}
            {appName} signs next; we mail you the signed copy as soon as it is
            done.
          </p>
        </div>
      </Shell>
    );
  }

  if (page.state === "completed") {
    return (
      <Shell appName={appName}>
        <div className={authCardClass}>
          <div className="text-md flex items-center gap-2 font-medium">
            <CheckCircle2 className="text-accent h-4 w-4" />
            &ldquo;{page.name}&rdquo; is signed
          </div>
          <p className="text-muted text-base">
            Signed by you and by {appName} on{" "}
            <Timestamp iso={page.completedAt} relative={false} />. The signed
            copy carries a certificate of the signing on its last page; it was
            mailed to you too.
          </p>
          <a
            href={customerDocumentPath(token, true)}
            className={buttonClass("primary", "md", "w-full")}
          >
            <Download className="h-3.5 w-3.5" />
            Download the signed copy
          </a>
        </div>
      </Shell>
    );
  }

  return <SignView token={token} appName={appName} page={page} />;
};

/** A token that opens nothing. It never says why. */
const RequestGone = () => (
  <AuthShell appName="Workspace" subtitle="A request for your signature">
    <div className={authCardClass}>
      <div className="text-md flex items-center gap-2 font-medium">
        <Link2Off className="text-subtle h-4 w-4" />
        This link does not work
      </div>
      <p className="text-muted text-base">
        The request may have ended, or the link was copied incompletely. Ask the
        person who sent it for a new one.
      </p>
    </div>
  </AuthShell>
);

/**
 * A customer's page for signing a PDF (#2974): no session, the token is the address and a code mailed to the
 * customer's address is the pass (`customerPage`). The code's forms are classic posts to this page; signing and
 * declining post JSON to it from the page's script (`customerPost`), and the page loads again with what follows.
 * Everything the customer reaches is under `/s/`, which a Cloudflare Access bypass covers.
 */
export const Route = createFileRoute("/s/sign/$token")({
  validateSearch: searchSchema,
  loader: ({ params }) => getSigning({ data: { token: params.token } }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData && "name" in loaderData.page
            ? `Sign ${loaderData.page.name} · ${loaderData.appName}`
            : (loaderData?.appName ?? "Workspace"),
      },
      // The token is the address: no search engine keeps it, and no page this one links to learns it.
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  server: {
    handlers: {
      POST: ({ request, params }) =>
        customerPost(env, createDb(env.DB), request, params.token),
    },
  },
  component: SigningPageView,
  notFoundComponent: RequestGone,
});

type SignPage = Extract<CustomerPage, { state: "sign" }>;
