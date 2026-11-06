import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FileSignature, PenLine } from "lucide-react";
import { useState } from "react";

import { SignatureDialog } from "~/components/drive/signature-pad";
import {
  Button,
  Empty,
  Notice,
  Pill,
  Section,
  Timestamp,
  ViewHeader,
} from "~/components/ui";
import { useAction } from "~/lib/action";
import {
  SIGNING_STATE_LABEL,
  SIGNING_STATE_TONE,
  signatureDataUrl,
} from "~/lib/drive/signing";
import { signingAction } from "~/lib/drive/signing-actions";
import {
  handSignatureOf,
  listSigningRequests,
} from "~/lib/drive/signing.server";
import type { SigningRow } from "~/lib/drive/signing.server";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { DriveError, driveTitle } from "./drive";

const getSignatures = createServerFn().handler(
  async (): Promise<{
    me: { name: string };
    signature: string | null;
    rows: SigningRow[];
  }> => {
    const { db, user } = await appContext();

    return {
      me: { name: user.name },
      signature: await handSignatureOf(db, user.id),
      rows: await listSigningRequests(db, user.id),
    };
  }
);

const RequestList = ({ rows }: { rows: SigningRow[] }) => (
  <ul className="divide-line divide-y">
    {rows.map((r) => (
      <li key={r.id}>
        <Link
          to="/drive/sign/r/$requestId"
          params={{ requestId: r.id }}
          className="hover:bg-hover flex items-center gap-3 px-4 py-2.5"
        >
          <FileSignature className="text-subtle h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="text-fg block truncate text-base">{r.name}</span>
            <span className="text-muted block truncate text-sm">
              {r.customer.name} · {r.customer.email}
              {r.createdBy.id !== r.signer.id &&
                ` · ${r.signer.name} signs for the workspace`}
            </span>
          </span>
          <Pill tone={SIGNING_STATE_TONE[r.state]}>
            {SIGNING_STATE_LABEL[r.state]}
          </Pill>
          <Timestamp
            iso={r.updatedAt}
            className="text-subtle w-16 text-right text-sm"
          />
        </Link>
      </li>
    ))}
  </ul>
);

const SignaturesPage = () => {
  const { me, signature, rows } = Route.useLoaderData();
  const act = useAction(signingAction);
  const [pad, setPad] = useState(false);
  const waiting = rows.filter((r) => r.myTurn);
  const rest = rows.filter((r) => !r.myTurn);
  const result = act.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader title="Signatures" count={rows.length} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
          {result && !result.ok && <Notice tone="error">{result.error}</Notice>}
          {result?.ok && result.message && (
            <Notice tone="success">{result.message}</Notice>
          )}

          <Section title="Your signature">
            <div className="flex flex-wrap items-center gap-3 p-4">
              {signature ? (
                <img
                  src={signatureDataUrl(signature)}
                  alt="Your saved signature"
                  className="h-12 max-w-[220px] rounded-sm bg-white object-contain px-2"
                />
              ) : (
                <p className="text-muted text-base">
                  Save your signature to sign for the workspace in one click,
                  and to sign automatically once a customer has signed.
                </p>
              )}
              <div className="ml-auto flex gap-2">
                {signature && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (
                        // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
                        confirm(
                          "Remove your saved signature? Requests set to sign automatically then wait for you."
                        )
                      ) {
                        void act.submit({ intent: "delete-signature" });
                      }
                    }}
                  >
                    Remove
                  </Button>
                )}
                <Button onClick={() => setPad(true)}>
                  <PenLine className="h-3.5 w-3.5" />
                  {signature ? "Change" : "Set up"}
                </Button>
              </div>
            </div>
          </Section>

          {waiting.length > 0 && (
            <Section title="Waiting for you to sign">
              <RequestList rows={waiting} />
            </Section>
          )}

          <Section title="Requests">
            {rest.length ? (
              <RequestList rows={rest} />
            ) : (
              <Empty
                icon={<FileSignature className="h-4 w-4" />}
                title="No requests yet"
              >
                Open a PDF in Drive and choose &ldquo;Request signatures&rdquo;
                to send it to a customer.
              </Empty>
            )}
          </Section>
        </div>
      </div>
      <SignatureDialog
        open={pad}
        name={me.name}
        submitLabel="Save my signature"
        note="Saved with your account: it signs for the workspace when you sign a request, and signs automatically where you choose to."
        onClose={() => setPad(false)}
        onAdopt={async (png) => {
          await act.submit({ intent: "save-signature", signature: png });
          setPad(false);
        }}
      />
    </div>
  );
};

/** Signatures (#2974): what waits for the person to sign, what they sent, and their own signature. */
export const Route = createFileRoute("/_app/drive/sign/")({
  // The requests stay when the minute's refresh cannot load them again (#3548).
  loader: (run) =>
    keepShown(run, () => getSignatures({ fetch: serverFnFetch })),
  head: () => ({ meta: [{ title: driveTitle("Signatures") }] }),
  component: SignaturesPage,
  errorComponent: DriveError,
});
