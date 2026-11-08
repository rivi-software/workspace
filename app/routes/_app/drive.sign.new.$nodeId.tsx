import {
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Send, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { z } from "zod";

import { PdfPages } from "~/components/drive/pdf-pages";
import { SignatureDialog } from "~/components/drive/signature-pad";
import {
  EditorLayer,
  FIELD_ICON,
  PARTY_TONE,
} from "~/components/drive/signing-fields";
import type { Tool } from "~/components/drive/signing-fields";
import { useShortcuts } from "~/components/keyboard";
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Notice,
  ViewHeader,
  cx,
  inputClass,
  selectClass,
  textareaClass,
} from "~/components/ui";
import { withCleanup } from "~/lib/cleanup";
import {
  FIELD_KIND_LABEL,
  MAX_LABEL,
  MAX_MESSAGE,
  PARTY_LABEL,
  signatureDataUrl,
} from "~/lib/drive/signing";
import type {
  SigningField,
  SigningFieldKind,
  SigningParty,
  SigningValues,
} from "~/lib/drive/signing";
import { sendSigningRequest, signingAction } from "~/lib/drive/signing-actions";
import { signingEditor } from "~/lib/drive/signing.server";
import type { SigningEditor } from "~/lib/drive/signing.server";
import { defined, errorMessage } from "~/lib/guards";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

import { DriveError, driveTitle } from "./drive";

const editorInput = z.object({ nodeId: z.coerce.string() });

const getEditor = createServerFn()
  .validator((d: { nodeId: string }) => editorInput.parse(d))
  .handler(async ({ data }): Promise<SigningEditor> => {
    const { db, user } = await appContext();
    const editor = await signingEditor(db, user, data.nodeId);

    if (!editor) {
      throw notFound();
    }

    return editor;
  });

const KINDS: SigningFieldKind[] = ["signature", "text", "date", "checkbox"];

/** The field picked on the PDF: for whom, its label, whether it is required and, for the workspace's own, its value. */
const SelectedField = ({
  field,
  riviValues,
  onUpdate,
  onRiviValues,
  onRemove,
}: {
  field: SigningField;
  riviValues: SigningValues;
  onUpdate: (id: string, change: Partial<SigningField>) => void;
  onRiviValues: Dispatch<SetStateAction<SigningValues>>;
  onRemove: () => void;
}) => (
  <div className="border-line space-y-2.5 rounded-md border p-3">
    <div className="flex items-center gap-2">
      <span
        className={cx(
          "rounded-[3px] border px-1.5 text-xs",
          PARTY_TONE[field.party]
        )}
      >
        {PARTY_LABEL[field.party]}
      </span>
      <span className="text-sm font-medium">
        {FIELD_KIND_LABEL[field.kind]}
      </span>
      <span className="text-subtle text-sm">page {field.page + 1}</span>
      <IconButton
        label="Remove the field"
        size="sm"
        className="ml-auto"
        onClick={() => {
          onRemove();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
    </div>
    <Field label="For">
      <select
        className={cx(selectClass, "w-full")}
        value={field.party}
        onChange={(e) =>
          onUpdate(field.id, {
            party: e.target.value === "rivi" ? "rivi" : "customer",
          })
        }
      >
        <option value="customer">{PARTY_LABEL.customer}</option>
        <option value="rivi">{PARTY_LABEL.rivi}</option>
      </select>
    </Field>
    {(field.kind === "text" || field.kind === "checkbox") && (
      <Field label="Label" hint="What the field asks for.">
        <input
          className={inputClass}
          value={field.label}
          maxLength={MAX_LABEL}
          onChange={(e) => onUpdate(field.id, { label: e.target.value })}
        />
      </Field>
    )}
    {(field.kind === "text" || field.kind === "checkbox") && (
      <label className="flex items-center gap-2.5">
        <Checkbox
          checked={field.required}
          onChange={(e) => onUpdate(field.id, { required: e.target.checked })}
        />
        {field.kind === "checkbox" ? "Must be ticked" : "Required"}
      </label>
    )}
    {field.party === "rivi" && field.kind === "text" && (
      <Field label="The workspace fills in">
        <input
          className={inputClass}
          value={riviValues[field.id] ?? ""}
          maxLength={500}
          onChange={(e) =>
            onRiviValues((v) => ({
              ...v,
              [field.id]: e.target.value,
            }))
          }
        />
      </Field>
    )}
    {field.party === "rivi" && field.kind === "checkbox" && (
      <label className="flex items-center gap-2.5">
        <Checkbox
          checked={riviValues[field.id] === "yes"}
          onChange={(e) =>
            onRiviValues((v) => ({
              ...v,
              [field.id]: e.target.checked ? "yes" : "",
            }))
          }
        />
        Ticked for the workspace
      </label>
    )}
    {field.kind === "date" && (
      <p className="text-muted text-sm">
        Filled in with the day {PARTY_LABEL[field.party]} signs.
      </p>
    )}
    {field.kind === "signature" && (
      <p className="text-muted text-sm">
        {PARTY_LABEL[field.party]}&apos;s signature goes here; one signature
        fills every signature field of theirs.
      </p>
    )}
  </div>
);

const Editor = ({ data }: { data: SigningEditor }) => {
  const navigate = useNavigate();
  const router = useRouter();
  const send = useServerFn(sendSigningRequest);
  const act = useServerFn(signingAction);
  const [fields, setFields] = useState<SigningField[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [party, setParty] = useState<SigningParty>("customer");
  const [tool, setTool] = useState<Tool>(null);
  const [riviValues, setRiviValues] = useState<SigningValues>({});
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [signerId, setSignerId] = useState(data.me.id);
  const [autoSign, setAutoSign] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const [saved, setSaved] = useState(data.savedSignature);

  const field = fields.find((f) => f.id === selected) ?? null;
  const signerIsMe = signerId === data.me.id;

  // Only the person who signs themselves can sign automatically: handing the signing to a colleague turns it off.
  if (!signerIsMe && autoSign) {
    setAutoSign(false);
  }

  useShortcuts([
    { keys: "Escape", run: () => (tool ? setTool(null) : setSelected(null)) },
  ]);

  const counts = useMemo(() => {
    const of = (p: SigningParty) => fields.filter((f) => f.party === p);

    return {
      customer: of("customer").length,
      rivi: of("rivi").length,
      customerSigns: of("customer").some((f) => f.kind === "signature"),
      riviSigns: of("rivi").some((f) => f.kind === "signature"),
    };
  }, [fields]);

  const update = (id: string, change: Partial<SigningField>) =>
    setFields((all) => all.map((f) => (f.id === id ? { ...f, ...change } : f)));

  const submit = async () => {
    setError(null);

    if (!counts.customerSigns || !counts.riviSigns) {
      setError(
        `Place a signature field for ${PARTY_LABEL[counts.customerSigns ? "rivi" : "customer"]} on the PDF.`
      );

      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        try {
          const result = await send({
            data: {
              nodeId: data.node.id,
              customerName,
              customerEmail,
              signerId,
              autoSign,
              message,
              fields,
              riviValues,
            },
          });

          if (!result.ok) {
            setError(result.error);

            return;
          }

          void navigate({
            to: "/drive/sign/r/$requestId",
            params: { requestId: defined(result.id, "the id") },
          });
        } catch (sendError) {
          setError(errorMessage(sendError));
        }
      },
      () => setBusy(false)
    );
  };

  const saveSignature = async (png: string) => {
    const form = new FormData();
    form.set("intent", "save-signature");
    form.set("signature", png);
    let result: Awaited<ReturnType<typeof act>>;

    // A call that fails outright is shown as a refusal is: nothing else catches it.
    try {
      result = await act({ data: form });
    } catch (saveError) {
      setError(errorMessage(saveError));

      return;
    }

    if (!result.ok) {
      setError(result.error);

      return;
    }

    setSaved(png);
    setPadOpen(false);
    void router.invalidate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title={
          <span className="truncate">Request signatures: {data.node.name}</span>
        }
        left={
          <IconButton
            label="Back to the file"
            onClick={() => {
              void navigate({
                to: "/drive/d/$nodeId",
                params: { nodeId: data.node.id },
              });
            }}
          >
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        }
      >
        <Button
          variant="primary"
          loading={busy}
          disabled={!!data.blocked}
          onClick={() => {
            void submit();
          }}
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
      </ViewHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
        <section
          aria-label="The PDF"
          className="bg-sidebar min-w-0 flex-1 px-4 py-6 xl:overflow-y-auto"
        >
          {tool && (
            <div className="border-line bg-elevated text-muted sticky top-0 z-10 mx-auto mb-3 flex w-full max-w-[880px] items-center gap-2 rounded-md border px-3 py-1.5 text-sm shadow-sm">
              Click on a page to place a{" "}
              {FIELD_KIND_LABEL[tool.kind].toLowerCase()} field for{" "}
              {PARTY_LABEL[tool.party]}.
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setTool(null)}
              >
                Done
              </Button>
            </div>
          )}
          <PdfPages
            src={`/api/drive/files/${data.node.id}`}
            renderOverlay={(page, shown) => (
              <EditorLayer
                page={page}
                shown={shown}
                fields={fields}
                selected={selected}
                tool={tool}
                values={riviValues}
                onChange={setFields}
                onSelect={setSelected}
                onPlaced={() => setTool(null)}
              />
            )}
          />
        </section>

        <aside
          aria-label="The request"
          className="border-line shrink-0 space-y-5 border-t px-4 py-4 text-base xl:w-80 xl:overflow-y-auto xl:border-t-0 xl:border-l"
        >
          {data.blocked && <Notice tone="error">{data.blocked}</Notice>}
          {error && (
            <Notice tone="error" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}

          <div className="space-y-2.5">
            <h2 className="text-subtle text-sm font-medium">Customer</h2>
            <Field label="Name">
              <input
                className={inputClass}
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                maxLength={120}
                autoComplete="off"
              />
            </Field>
            <Field label="Email">
              <input
                className={inputClass}
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </div>

          <div className="space-y-2.5">
            <h2 className="text-subtle text-sm font-medium">
              Signs for the workspace
            </h2>
            <select
              className={cx(selectClass, "w-full")}
              value={signerId}
              onChange={(e) => setSignerId(e.target.value)}
              aria-label="Who signs for the workspace"
            >
              <option value={data.me.id}>Me ({data.me.name})</option>
              {data.colleagues.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label
              className={cx(
                "flex items-start gap-2.5",
                !signerIsMe && "opacity-50"
              )}
            >
              <Checkbox
                className="mt-0.5"
                checked={autoSign}
                disabled={!signerIsMe || !saved}
                onChange={(e) => setAutoSign(e.target.checked)}
              />
              <span>
                Sign automatically
                <span className="text-muted block text-sm">
                  {signerIsMe
                    ? "Once the customer has signed, your saved signature signs for the workspace and the signed copy goes out at once."
                    : "Only when you sign yourself."}
                </span>
              </span>
            </label>
            {signerIsMe && (
              <div className="flex items-center gap-2 pl-6">
                {saved && (
                  <img
                    src={signatureDataUrl(saved)}
                    alt="Your saved signature"
                    className="h-8 max-w-[140px] rounded-sm bg-white object-contain px-1"
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPadOpen(true)}
                >
                  {saved ? "Change" : "Set up your signature"}
                </Button>
              </div>
            )}
          </div>

          <Field
            label="Message (optional)"
            hint="Goes into the mail to the customer."
          >
            <textarea
              className={textareaClass}
              rows={3}
              maxLength={MAX_MESSAGE}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>

          <div className="space-y-2.5">
            <h2 className="text-subtle text-sm font-medium">Fields</h2>
            <div
              className="bg-hover grid grid-cols-2 gap-1 rounded-md p-0.5"
              role="radiogroup"
              aria-label="For whom"
            >
              {(["customer", "rivi"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a segmented control styled as buttons; a native radio input cannot take this markup
                  role="radio"
                  aria-checked={party === p}
                  onClick={() => {
                    setParty(p);

                    if (tool) {
                      setTool({ ...tool, party: p });
                    }
                  }}
                  className={cx(
                    "h-6 rounded-[5px] text-sm transition-colors",
                    party === p
                      ? "bg-elevated text-fg shadow-sm"
                      : "text-muted hover:text-fg"
                  )}
                >
                  {PARTY_LABEL[p]}{" "}
                  <span className="tnum text-subtle">{counts[p]}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {KINDS.map((kind) => {
                const Icon = FIELD_ICON[kind];
                const active = tool?.kind === kind && tool.party === party;

                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTool(active ? null : { kind, party })}
                    className={cx(
                      "flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm transition-colors",
                      active ? PARTY_TONE[party] : "border-line hover:bg-hover"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {FIELD_KIND_LABEL[kind]}
                  </button>
                );
              })}
            </div>
            <p className="text-muted text-sm">
              Choose a field, then click where it goes. Drag a field to move it,
              its corner to size it. The workspace&apos;s texts and boxes are
              filled in here, before sending: the customer signs them as they
              are.
            </p>
          </div>

          {field && (
            <SelectedField
              field={field}
              riviValues={riviValues}
              onUpdate={update}
              onRiviValues={setRiviValues}
              onRemove={() => {
                setFields((all) => all.filter((f) => f.id !== field.id));
                setSelected(null);
              }}
            />
          )}
        </aside>
      </div>

      <SignatureDialog
        open={padOpen}
        name={data.me.name}
        title="Your signature"
        submitLabel="Save my signature"
        note="Saved with your account: it signs for the workspace when you sign a request, and signs automatically where you choose to."
        onClose={() => setPadOpen(false)}
        onAdopt={saveSignature}
      />
    </div>
  );
};

const EditorPage = () => {
  const data = Route.useLoaderData();

  return <Editor key={data.node.id} data={data} />;
};

/** Placing the fields on a PDF and sending it for signatures (#2974). */
export const Route = createFileRoute("/_app/drive/sign/new/$nodeId")({
  // The editor stays when the minute's refresh cannot load it again (#3548): an error state in its place would take
  // the fields placed so far with it.
  loader: (run) =>
    keepShown(run, () =>
      getEditor({ data: { nodeId: run.params.nodeId }, fetch: serverFnFetch })
    ),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: driveTitle(
          `Request signatures: ${loaderData?.node.name ?? "PDF"}`
        ),
      },
    ],
  }),
  component: EditorPage,
  errorComponent: DriveError,
});
