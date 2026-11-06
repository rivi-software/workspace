import {
  Calendar,
  CheckSquare,
  PenLine,
  TextCursorInput,
  X,
} from "lucide-react";
import { useRef } from "react";

import {
  FIELD_DEFAULT_SIZE,
  FIELD_KIND_LABEL,
  MIN_FIELD,
  PARTY_LABEL,
  signatureDataUrl,
  signingDate,
} from "~/lib/drive/signing";
import type {
  SigningField,
  SigningFieldKind,
  SigningParty,
  SigningValues,
} from "~/lib/drive/signing";
import { defined } from "~/lib/guards";

import { cx } from "../ui";
import type { ShownPage } from "./pdf-pages";

export const FIELD_ICON: Record<
  SigningFieldKind,
  React.ComponentType<{ className?: string }>
> = {
  signature: PenLine,
  text: TextCursorInput,
  date: Calendar,
  checkbox: CheckSquare,
};

/** Each party's colour on the page: the customer blue, RIVI the accent. */
export const PARTY_TONE: Record<SigningParty, string> = {
  customer: "border-sky-500 bg-sky-500/15 text-sky-900",
  rivi: "border-emerald-600 bg-emerald-500/15 text-emerald-900",
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** A field's box on its page layer, in percentages. */
const boxStyle = (f: SigningField): React.CSSProperties => ({
  left: `${f.x * 100}%`,
  top: `${f.y * 100}%`,
  width: `${f.w * 100}%`,
  height: `${f.h * 100}%`,
});

/** The text size for a field's box: about its height, readable at any zoom. */
const textSize = (f: SigningField, shown: ShownPage): number =>
  clamp(f.h * shown.height * shown.scale * 0.62, 8, 18);

export type Tool = { kind: SigningFieldKind; party: SigningParty } | null;

let counter = 0;

const fieldId = (): string => {
  counter += 1;

  return `f${Date.now().toString(36)}${counter.toString(36)}`;
};

/** What a field in the editor shows: a ticked box, or its icon with the value filled in (else its label). */
const EditorFace = ({
  field,
  value,
}: {
  field: SigningField;
  value: string | undefined;
}) => {
  if (field.kind === "checkbox") {
    return value === "yes" ? (
      <CheckSquare className="m-auto h-[80%] w-auto" />
    ) : null;
  }

  const Icon = FIELD_ICON[field.kind];

  return (
    <>
      <Icon className="h-[1em] w-[1em] shrink-0 opacity-70" />
      <span className="truncate leading-none">{value || field.label}</span>
    </>
  );
};

/**
 * The editor's layer on one page: with a tool chosen, a click places a field of it there; a field is selected by a
 * click, moved by dragging it and sized by its corner, and removed with its cross (or Delete while selected).
 */
export const EditorLayer = ({
  page,
  shown,
  fields,
  selected,
  tool,
  values,
  onChange,
  onSelect,
  onPlaced,
}: {
  page: number;
  shown: ShownPage;
  fields: SigningField[];
  selected: string | null;
  tool: Tool;
  /** RIVI's values as filled in, shown in their boxes. */
  values: SigningValues;
  onChange: (fields: SigningField[]) => void;
  onSelect: (id: string | null) => void;
  onPlaced: () => void;
}) => {
  const layer = useRef<HTMLDivElement | null>(null);

  const fraction = (e: { clientX: number; clientY: number }) => {
    const rect = defined(layer.current, "the current").getBoundingClientRect();

    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  };

  /** Follows the pointer from a press on a field (moving it) or its corner (sizing it). */
  const drag = (
    e: React.PointerEvent,
    field: SigningField,
    mode: "move" | "size"
  ) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(field.id);
    const start = fraction(e);
    const { currentTarget: target } = e;

    // A field and its corner are elements the browser can capture the pointer on; anything else has nothing to follow.
    if (!(target instanceof HTMLElement)) {
      return;
    }

    target.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const now = fraction(ev);
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      onChange(
        fields.map((f) => {
          if (f.id !== field.id) {
            return f;
          }

          if (mode === "move") {
            return {
              ...f,
              x: clamp(field.x + dx, 0, 1 - field.w),
              y: clamp(field.y + dy, 0, 1 - field.h),
            };
          }

          return {
            ...f,
            w: clamp(field.w + dx, MIN_FIELD * 2, 1 - field.x),
            h: clamp(field.h + dy, MIN_FIELD, 1 - field.y),
          };
        })
      );
    };

    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };

    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={layer}
      className={cx("absolute inset-0", tool && "cursor-copy")}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) {
          return;
        }

        if (!tool) {
          return onSelect(null);
        }

        const at = fraction(e);
        const size = FIELD_DEFAULT_SIZE[tool.kind];
        // The default sizes are for A4; a landscape or odd page keeps the same look in points.
        const w = clamp(size.w * (595 / shown.width), MIN_FIELD * 2, 1);
        const h = clamp(size.h * (842 / shown.height), MIN_FIELD, 1);

        const field: SigningField = {
          id: fieldId(),
          kind: tool.kind,
          party: tool.party,
          page,
          x: clamp(at.x - w / 2, 0, 1 - w),
          y: clamp(at.y - h / 2, 0, 1 - h),
          w,
          h,
          label: FIELD_KIND_LABEL[tool.kind],
          required: true,
        };

        onChange([...fields, field]);
        onSelect(field.id);
        onPlaced();
      }}
    >
      {fields
        .filter((f) => f.page === page)
        .map((f) => {
          const active = selected === f.id;
          const value = f.party === "rivi" ? values[f.id] : undefined;

          return (
            <div
              key={f.id}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the field holds its own remove button and resize handle, and a button element cannot contain a button
              role="button"
              tabIndex={0}
              aria-label={`${PARTY_LABEL[f.party]}: ${f.label}`}
              aria-pressed={active}
              className={cx(
                "absolute flex touch-none select-none items-center gap-1 overflow-hidden rounded-[3px] border px-1 cursor-move",
                PARTY_TONE[f.party],
                active && "ring-2 ring-offset-1 ring-sky-400"
              )}
              style={{ ...boxStyle(f), fontSize: textSize(f, shown) }}
              onPointerDown={(e) => drag(e, f, "move")}
              onKeyDown={(e) => {
                if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  onChange(fields.filter((x) => x.id !== f.id));
                  onSelect(null);
                }
              }}
              onFocus={() => onSelect(f.id)}
            >
              <EditorFace field={f} value={value} />
              {active && (
                <>
                  <button
                    type="button"
                    aria-label="Remove the field"
                    className="absolute top-0 right-0 flex h-3.5 w-3.5 items-center justify-center rounded-bl-[3px] bg-black/60 text-white"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange(fields.filter((x) => x.id !== f.id));
                      onSelect(null);
                    }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                  <span
                    aria-hidden
                    className="absolute right-0 bottom-0 h-2.5 w-2.5 cursor-nwse-resize bg-black/60"
                    onPointerDown={(e) => drag(e, f, "size")}
                  />
                </>
              )}
            </div>
          );
        })}
    </div>
  );
};

const NO_VALUES: SigningValues = {};

const NO_SIGNATURES: Partial<Record<SigningParty, string | null>> = {};

/** What another party's field shows: their signature (or where they sign), a ticked box, or the text filled in. */
const OtherFace = ({
  field,
  value,
  given,
}: {
  field: SigningField;
  value: string | undefined;
  given: string | null | undefined;
}) => {
  if (field.kind === "signature") {
    return given ? (
      <img
        src={signatureDataUrl(given)}
        alt=""
        className="m-auto max-h-full max-w-full"
      />
    ) : (
      <span className="truncate opacity-70">
        {PARTY_LABEL[field.party]} signs here
      </span>
    );
  }

  if (field.kind === "checkbox") {
    return value === "yes" ? (
      <CheckSquare className="m-auto h-[80%] w-auto" />
    ) : null;
  }

  return (
    <span className="truncate">
      {value || <span className="opacity-60">{field.label}</span>}
    </span>
  );
};

/**
 * A signer's layer on one page: their own fields to fill in (a text, a box to tick, their signature, the date it
 * takes when they sign), and the other party's as they stand, to read.
 */
export const FillLayer = ({
  page,
  shown,
  fields,
  party,
  values,
  mine = NO_VALUES,
  signature = null,
  signatures = NO_SIGNATURES,
  fixed = false,
  onValue,
  onSign,
}: {
  page: number;
  shown: ShownPage;
  fields: SigningField[];
  /** Who signs now; null to only read. */
  party: SigningParty | null;
  /** What is filled in already. */
  values: SigningValues;
  /** What the party signing now filled in so far. */
  mine?: SigningValues;
  /** Their signature, once adopted. */
  signature?: string | null;
  /** The signatures already given, shown in their fields. */
  signatures?: Partial<Record<SigningParty, string | null>>;
  /** Whether the party's own texts and boxes stand as `values` has them (RIVI's, filled in before sending). */
  fixed?: boolean;
  onValue?: (id: string, value: string) => void;
  onSign?: () => void;
}) => (
  <>
    {fields
      .filter((f) => f.page === page)
      .map((f) => {
        const own =
          f.party === party &&
          !(fixed && (f.kind === "text" || f.kind === "checkbox"));

        const style = { ...boxStyle(f), fontSize: textSize(f, shown) };

        const base = "absolute flex items-center overflow-hidden rounded-[3px]";

        if (!own) {
          const value = values[f.id];
          const given = signatures[f.party];

          return (
            <div
              key={f.id}
              className={cx(
                base,
                "px-1 text-[#14183a]",
                given && f.kind === "signature"
                  ? ""
                  : cx("border border-dashed", PARTY_TONE[f.party]),
                "bg-transparent"
              )}
              style={style}
              title={`${PARTY_LABEL[f.party]}: ${f.label}`}
            >
              <OtherFace field={f} value={value} given={given} />
            </div>
          );
        }

        if (f.kind === "signature") {
          return (
            <button
              key={f.id}
              type="button"
              onClick={onSign}
              className={cx(
                base,
                "justify-center border",
                signature
                  ? "border-transparent bg-transparent hover:border-sky-500"
                  : cx(PARTY_TONE[f.party], "font-medium")
              )}
              style={style}
              aria-label={signature ? "Change your signature" : "Sign here"}
            >
              {signature ? (
                <img
                  src={signatureDataUrl(signature)}
                  alt="Your signature"
                  className="max-h-full max-w-full"
                />
              ) : (
                <span className="flex items-center gap-1 truncate">
                  <PenLine className="h-[1em] w-[1em]" />
                  Sign here
                </span>
              )}
            </button>
          );
        }

        if (f.kind === "date") {
          return (
            <div
              key={f.id}
              className={cx(
                base,
                "border px-1 text-[#14183a]",
                PARTY_TONE[f.party]
              )}
              style={style}
              title="Filled in when you sign"
            >
              <span className="truncate">{signingDate()}</span>
            </div>
          );
        }

        if (f.kind === "checkbox") {
          return (
            <label
              key={f.id}
              className={cx(base, "justify-center border", PARTY_TONE[f.party])}
              style={style}
              title={f.label}
            >
              <input
                type="checkbox"
                className="h-[80%] w-[80%] accent-[#14183a]"
                checked={mine[f.id] === "yes"}
                onChange={(e) => onValue?.(f.id, e.target.checked ? "yes" : "")}
                aria-label={f.label}
                required={f.required}
              />
            </label>
          );
        }

        return (
          <input
            key={f.id}
            className={cx(
              base,
              "border px-1 text-[#14183a] outline-none placeholder:text-[#14183a]/50 focus:ring-2 focus:ring-sky-400",
              PARTY_TONE[f.party]
            )}
            style={style}
            value={mine[f.id] ?? ""}
            placeholder={f.label}
            aria-label={f.label}
            required={f.required}
            maxLength={500}
            onChange={(e) => onValue?.(f.id, e.target.value)}
          />
        );
      })}
  </>
);
