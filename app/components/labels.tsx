import { Link } from "@tanstack/react-router";
import { Plus, Settings2, Tag, X } from "lucide-react";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { LABEL_COLORS } from "~/lib/mail/folders";
import type { LabelColor, LabelRef } from "~/lib/mail/folders";

import { Checkbox, IconButton, Popover, cx, inputClass } from "./ui";

/** The CSS of a label's colour, from the palette in `app.css`. */
export const labelStyle = (color: LabelColor): CSSProperties => ({
  color: `var(--label-${color})`,
  background: `var(--label-${color}-soft)`,
});

export const labelDotStyle = (color: LabelColor): CSSProperties => ({
  background: `var(--label-${color})`,
});

export const LabelChip = ({
  label,
  onRemove,
  className,
  size = "sm",
}: {
  label: LabelRef;
  onRemove?: () => void;
  className?: string;
  size?: "xs" | "sm";
}) => (
  <span
    style={labelStyle(label.color)}
    className={cx(
      "inline-flex max-w-40 shrink-0 items-center gap-1 rounded-[4px] font-medium",
      size === "xs" ? "h-4 px-1 text-2xs" : "h-5 px-1.5 text-xs",
      className
    )}
  >
    <span className="truncate">{label.name}</span>
    {onRemove && (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        aria-label={`Remove label ${label.name}`}
        className="-mr-0.5 rounded-sm opacity-60 hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    )}
  </span>
);

/** A dot of a label's colour for the palette and the sidebar. */
export const LabelDot = ({
  color,
  className,
}: {
  color: LabelColor;
  className?: string;
}) => (
  <span
    aria-hidden
    style={labelDotStyle(color)}
    className={cx("inline-block h-2 w-2 shrink-0 rounded-full", className)}
  />
);

export const ColorPalette = ({
  value,
  onChange,
  name,
}: {
  value: LabelColor;
  onChange?: (c: LabelColor) => void;
  name?: string;
}) => (
  <div
    role="radiogroup"
    aria-label="Colour"
    className="flex flex-wrap items-center gap-1"
  >
    {LABEL_COLORS.map((c) => (
      <label
        key={c}
        title={c}
        aria-label={c}
        className={cx(
          "flex h-6 w-6 cursor-default items-center justify-center rounded-md border transition-colors hover:bg-hover",
          value === c ? "border-line-strong bg-active" : "border-transparent"
        )}
      >
        <input
          type="radio"
          name={name}
          value={c}
          checked={value === c}
          onChange={() => onChange?.(c)}
          className="sr-only"
        />
        <span style={labelDotStyle(c)} className="h-3.5 w-3.5 rounded-full" />
      </label>
    ))}
  </div>
);

/**
 * The label menu on the list and the thread: the person's labels with a box each (on when every chosen thread has
 * it, half when some do), a search that becomes "Create" when nothing matches, and the way to the settings.
 */
export const LabelPicker = ({
  labels,
  state,
  onToggle,
  onCreate,
  renderTrigger,
  align = "end",
  open,
  onOpenChange,
}: {
  labels: LabelRef[];
  /** For each label id, whether every target has it ("all"), some do ("some"), or none. */
  state: Map<string, "all" | "some">;
  onToggle: (label: LabelRef, on: boolean) => void;
  onCreate: (name: string) => Promise<LabelRef | null>;
  renderTrigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const needle = q.trim().toLowerCase();

  const shown = needle
    ? labels.filter((l) => l.name.toLowerCase().includes(needle))
    : labels;

  const exact = labels.some((l) => l.name.toLowerCase() === needle);

  const create = async () => {
    if (!needle || busy) {
      return;
    }

    setBusy(true);
    const made = await onCreate(q.trim());
    setBusy(false);

    if (made) {
      onToggle(made, true);
      setQ("");
    }
  };

  return (
    <Popover
      label="Labels"
      align={align}
      renderTrigger={renderTrigger}
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setQ("");
        }

        onOpenChange?.(o);
      }}
      panelClassName="w-64"
    >
      {({ close }) => (
        <div>
          <input
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();

                if (shown.length === 1 && !needle) {
                  return;
                }

                if (shown.length && (exact || !needle)) {
                  const [first] = shown;
                  onToggle(first, state.get(first.id) !== "all");
                } else if (needle) {
                  create();
                }
              }
            }}
            placeholder={labels.length ? "Label as…" : "New label…"}
            aria-label="Label as"
            className={cx(inputClass, "mb-1 h-7")}
          />
          <div className="max-h-64 overflow-y-auto">
            {shown.map((l) => {
              const s = state.get(l.id);

              return (
                <label
                  key={l.id}
                  className="text-fg hover:bg-hover flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-base"
                >
                  <Checkbox
                    checked={s === "all"}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate = s === "some";
                      }
                    }}
                    onChange={(e) => onToggle(l, e.currentTarget.checked)}
                  />
                  <LabelDot color={l.color} />
                  <span className="flex-1 truncate">{l.name}</span>
                </label>
              );
            })}
            {!shown.length && !needle && (
              <div className="text-subtle px-2 py-2 text-sm">
                No labels yet. Type a name to make one.
              </div>
            )}
          </div>
          {needle && !exact && (
            <button
              type="button"
              onClick={() => {
                create();
              }}
              disabled={busy}
              className="text-fg hover:bg-hover mt-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-base disabled:opacity-50"
            >
              <Plus className="text-muted h-3.5 w-3.5" />
              <span className="truncate">Create “{q.trim()}”</span>
            </button>
          )}
          <div className="border-line mt-1 border-t pt-1">
            <Link
              to="/settings"
              search={{ tab: "mail" }}
              onClick={close}
              className="text-muted hover:bg-hover hover:text-fg flex h-7 items-center gap-2 rounded-md px-2 text-base"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Manage labels
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
};

export const LabelTriggerButton = ({
  open,
  toggle,
  size = "md",
}: {
  open: boolean;
  toggle: () => void;
  size?: "sm" | "md";
}) => (
  <IconButton
    label="Labels (l)"
    size={size}
    onClick={toggle}
    active={open}
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    <Tag className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
  </IconButton>
);
