import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  BellRing,
  Copy,
  Download,
  ExternalLink,
  PenLine,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { PdfPages } from "~/components/drive/pdf-pages";
import { SignatureDialog } from "~/components/drive/signature-pad";
import { FillLayer } from "~/components/drive/signing-fields";
import {
  Button,
  IconButton,
  Notice,
  Pill,
  Timestamp,
  ViewHeader,
  buttonClass,
} from "~/components/ui";
import { useAction } from "~/lib/action";
import {
  SIGNING_STATE_LABEL,
  SIGNING_STATE_TONE,
  signatureDataUrl,
  signingDocumentHref,
} from "~/lib/drive/signing";
import { signingAction } from "~/lib/drive/signing-actions";
import type { SigningResult } from "~/lib/drive/signing-actions";
import { signingRequestView } from "~/lib/drive/signing.server";
import type { SigningRequestView } from "~/lib/drive/signing.server";
import { defined } from "~/lib/guards";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { DriveError, driveTitle } from "./drive";

const loadRequest = createServerFn()
  .validator((d: { id: string }) => ({ id: String(d?.id ?? "") }))
  .handler(async ({ data }): Promise<SigningRequestView> => {
    const { db, env, user } = await appContext();
    const view = await signingRequestView(env, db, user.id, data.id);

    if (!view) {
      throw notFound();
    }

    return view;
  });

const Detail = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div>
    <dt className="text-subtle text-xs">{label}</dt>
    <dd className="text-fg min-w-0 break-words">{children}</dd>
  </div>
);

type RequestIntent = "remind" | "cancel";

/** The header's buttons: remind or cancel while the request is open, the signed copy once it is done. */
const RequestActions = ({
  r,
  busy,
  onIntent,
}: {
  r: SigningRequestView;
  busy: boolean;
  onIntent: (intent: RequestIntent) => void;
}) => (
  <>
    {r.canRemind && (
      <Button loading={busy} onClick={() => onIntent("remind")}>
        <BellRing className="h-3.5 w-3.5" />
        Remind
      </Button>
    )}
    {r.canCancel && (
      <Button
        variant="ghost"
        onClick={() => {
          if (
            // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
            confirm("Cancel this request? Its link stops working at once.")
          ) {
            onIntent("cancel");
          }
        }}
      >
        <XCircle className="h-3.5 w-3.5" />
        Cancel request
      </Button>
    )}
    {r.state === "completed" && (
      <a
        href={signingDocumentHref(r.id, true)}
        className={buttonClass("primary")}
      >
        <Download className="h-3.5 w-3.5" />
        Signed copy
      </a>
    )}
  </>
);

/** What the last action answered: its error or its message. */
const RequestNotices = ({
  result,
  error,
}: {
  result: SigningResult | undefined;
  error: string | null;
}) => (
  <>
    {(result && !result.ok && <Notice tone="error">{result.error}</Notice>) ||
      (error && <Notice tone="error">{error}</Notice>)}
    {result?.ok && result.message && (
      <Notice tone="success">{result.message}</Notice>
    )}
  </>
);

/** The customer has signed: the workspace's signer signs now, with the saved signature or a new drawing. */
const OurTurn = ({
  r,
  busy,
  onSignSaved,
  onDraw,
}: {
  r: SigningRequestView;
  busy: boolean;
  onSignSaved: () => void;
  onDraw: () => void;
}) => (
  <div className="border-line bg-elevated flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5">
    <PenLine className="text-accent h-4 w-4" />
    <span className="min-w-0 flex-1 text-base">
      {r.customer.name} signed. Sign for the workspace to finish it: the signed
      copy goes into Drive and to the customer.
    </span>
    {r.savedSignature && (
      <Button variant="primary" loading={busy} onClick={onSignSaved}>
        <img
          src={signatureDataUrl(r.savedSignature)}
          alt=""
          className="h-4 max-w-16 rounded-[2px] bg-white object-contain"
        />
        Sign with my signature
      </Button>
    )}
    <Button
      variant={r.savedSignature ? "secondary" : "primary"}
      onClick={onDraw}
    >
      {r.savedSignature ? "Draw another" : "Sign"}
    </Button>
  </div>
);

const RequestHistory = ({
  events,
}: {
  events: SigningRequestView["events"];
}) => (
  <>
    <h2 className="text-subtle mt-5 mb-2 text-sm font-medium">History</h2>
    <ol className="border-line space-y-2.5 border-l pl-3">
      {events.map((e) => (
        <li key={e.id} className="text-sm">
          <div className="text-fg">{e.what}</div>
          <div className="text-muted">
            {e.actor}
            {e.ip && <span className="text-subtle"> · {e.ip}</span>}
          </div>
          {e.detail && e.kind !== "completed" && (
            <div className="text-subtle">{e.detail}</div>
          )}
          <Timestamp
            iso={e.at}
            relative={false}
            className="text-subtle text-xs"
          />
        </li>
      ))}
    </ol>
  </>
);

const RequestDetails = ({ r }: { r: SigningRequestView }) => {
  const [copied, setCopied] = useState(false);

  return (
    <aside
      aria-label="Details"
      className="border-line bg-sidebar shrink-0 border-t px-4 py-4 text-base xl:w-80 xl:overflow-y-auto xl:border-t-0 xl:border-l"
    >
      <dl className="space-y-2.5">
        <Detail label="Customer">
          {r.customer.name}
          <span className="text-muted block text-sm">{r.customer.email}</span>
        </Detail>
        <Detail label="Signs for the workspace">
          {r.signer.name}
          {r.autoSign && (
            <span className="text-muted block text-sm">
              Automatically, once the customer has signed
            </span>
          )}
        </Detail>
        <Detail label="Sent by">
          {r.createdBy.name}, <Timestamp iso={r.createdAt} relative={false} />
        </Detail>
        {(r.state === "awaiting-customer" || r.state === "awaiting-rivi") && (
          <Detail label="Open until">
            <Timestamp iso={r.expiresAt} relative={false} />
          </Detail>
        )}
        {r.url && (
          <Detail label="The customer's link">
            <button
              type="button"
              className="text-accent inline-flex items-center gap-1 hover:underline"
              onClick={() => {
                navigator.clipboard.writeText(defined(r.url, "the url"));
                setCopied(true);
              }}
            >
              <Copy className="h-3 w-3" />
              {copied ? "Copied" : "Copy"}
            </button>
            <span className="text-muted block text-sm">
              It opens after a code mailed to {r.customer.email}.
            </span>
          </Detail>
        )}
        {r.declineReason && (
          <Detail label="Their reason">{r.declineReason}</Detail>
        )}
        {(r.signedNodeId || r.nodeId) && (
          <Detail label="In Drive">
            <span className="flex flex-col gap-0.5">
              {r.signedNodeId && (
                <Link
                  to="/drive/d/$nodeId"
                  params={{ nodeId: r.signedNodeId }}
                  className="text-accent inline-flex items-center gap-1 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  The signed copy
                </Link>
              )}
              {r.nodeId && (
                <Link
                  to="/drive/d/$nodeId"
                  params={{ nodeId: r.nodeId }}
                  className="text-accent inline-flex items-center gap-1 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  The original
                </Link>
              )}
            </span>
          </Detail>
        )}
        <Detail label="Original's SHA-256">
          <code className="text-muted font-mono text-xs break-all">
            {r.originalSha256}
          </code>
        </Detail>
        {r.signedSha256 && (
          <Detail label="Signed copy's SHA-256">
            <code className="text-muted font-mono text-xs break-all">
              {r.signedSha256}
            </code>
          </Detail>
        )}
      </dl>

      <RequestHistory events={r.events} />
    </aside>
  );
};

const RequestView = ({ r }: { r: SigningRequestView }) => {
  const navigate = useNavigate();
  const act = useAction(signingAction, { id: r.id });
  const [pad, setPad] = useState(false);
  const busy = act.state === "submitting";

  const sign = async (signature: string | null) => {
    await act.submit(
      signature ? { intent: "sign", signature } : { intent: "sign" }
    );
    setPad(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{r.name}</span>
            <Pill tone={SIGNING_STATE_TONE[r.state]}>
              {SIGNING_STATE_LABEL[r.state]}
            </Pill>
          </span>
        }
        left={
          <IconButton
            label="Back to signatures"
            onClick={() => {
              navigate({ to: "/drive/sign" });
            }}
          >
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        }
      >
        <RequestActions
          r={r}
          busy={busy}
          onIntent={(intent) => {
            act.submit({ intent });
          }}
        />
      </ViewHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
        <section
          aria-label="The PDF"
          className="bg-sidebar min-w-0 flex-1 px-4 py-6 xl:overflow-y-auto"
        >
          <div className="mx-auto mb-4 w-full max-w-[880px] space-y-3">
            <RequestNotices result={act.data} error={act.error} />
            {r.myTurn && (
              <OurTurn
                r={r}
                busy={busy}
                onSignSaved={() => sign(null)}
                onDraw={() => setPad(true)}
              />
            )}
          </div>
          {r.state === "completed" ? (
            <PdfPages src={signingDocumentHref(r.id, true)} />
          ) : (
            <PdfPages
              src={signingDocumentHref(r.id)}
              renderOverlay={(page, shown) => (
                <FillLayer
                  page={page}
                  shown={shown}
                  fields={r.fields}
                  party={r.myTurn ? "rivi" : null}
                  fixed
                  values={r.values}
                  signatures={{ customer: r.customerSignature }}
                  onSign={() => setPad(true)}
                />
              )}
            />
          )}
        </section>

        <RequestDetails r={r} />
      </div>

      <SignatureDialog
        open={pad}
        name={r.signer.name}
        title="Sign for the workspace"
        submitLabel="Sign"
        note={`Signing finishes "${r.name}": the signed copy goes into Drive and to ${r.customer.name}.`}
        onClose={() => setPad(false)}
        onAdopt={(png) => sign(png)}
      />
    </div>
  );
};

const RequestPage = () => {
  const data = Route.useLoaderData();

  return <RequestView key={data.id} r={data} />;
};

/** A request for signatures (#2974): where it stands, its history, and the person's signature when it is their turn. */
export const Route = createFileRoute("/_app/drive/sign/r/$requestId")({
  // The request stays when the minute's refresh cannot load it again (#3548).
  loader: (run) =>
    keepShown(run, () =>
      loadRequest({ data: { id: run.params.requestId }, fetch: serverFnFetch })
    ),
  head: ({ loaderData }) => ({
    meta: [{ title: driveTitle(loaderData?.name ?? "Signatures") }],
  }),
  component: RequestPage,
  errorComponent: DriveError,
});
