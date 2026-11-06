import { Clock } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import {
  snoozeLabel,
  snoozePresets,
  toLocalInputValue,
} from "~/lib/mail/snooze";
import type { SnoozePreset } from "~/lib/mail/snooze";

import { Button, IconButton, Popover, cx, inputClass } from "./ui";

/** How far ahead the earliest moment a reader may pick lies. */
const EARLIEST_CUSTOM_MS = 5 * 60_000;

/** The earliest moment the custom picker offers, as the input's own value. */
const earliestCustom = () =>
  toLocalInputValue(new Date(Date.now() + EARLIEST_CUSTOM_MS));

/**
 * The snooze menu: later today, tomorrow, the weekend, next week, or a moment of the reader's choosing. With other
 * `presets`, a `heading` and a `submitLabel` it is the composer's "Send later" too.
 */
export const SnoozeMenu = ({
  onPick,
  renderTrigger,
  align = "end",
  above = false,
  heading = "Snooze until",
  submitLabel = "Snooze",
  presets: makePresets = snoozePresets,
  width = "w-64",
}: {
  onPick: (iso: string) => void;
  renderTrigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  align?: "start" | "end";
  /** Open upwards, for a trigger at the bottom of the screen. */
  above?: boolean;
  heading?: string;
  submitLabel?: string;
  presets?: () => SnoozePreset[];
  /** The panel's width class, for labels longer than the snooze menu's. */
  width?: string;
}) => {
  const [custom, setCustom] = useState("");
  const inputId = useId();

  return (
    <Popover
      label={heading}
      align={align}
      renderTrigger={renderTrigger}
      panelClassName={cx(width, above && "bottom-full mb-1")}
    >
      {({ close }) => {
        const presets = makePresets();

        const pick = (iso: string) => {
          close();
          onPick(iso);
        };

        return (
          <div>
            <div className="text-subtle px-2 pt-1.5 pb-1 text-xs font-medium">
              {heading}
            </div>
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => pick(p.at.toISOString())}
                className="text-fg hover:bg-hover flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-base"
              >
                <span className="whitespace-nowrap">{p.label}</span>
                <span className="tnum text-subtle text-sm whitespace-nowrap">
                  {snoozeLabel(p.at)}
                </span>
              </button>
            ))}
            <div className="border-line mt-1 border-t px-2 pt-2 pb-1">
              <label
                htmlFor={inputId}
                className="text-subtle mb-1 block text-xs font-medium"
              >
                Pick a date and time
              </label>
              <div className="flex items-center gap-1">
                <input
                  id={inputId}
                  type="datetime-local"
                  value={custom}
                  min={earliestCustom()}
                  onChange={(e) => setCustom(e.currentTarget.value)}
                  aria-label={heading}
                  className={cx(inputClass, "h-7 text-sm")}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!custom || Number.isNaN(new Date(custom).getTime())}
                  onClick={() => pick(new Date(custom).toISOString())}
                >
                  {submitLabel}
                </Button>
              </div>
            </div>
          </div>
        );
      }}
    </Popover>
  );
};

export const SnoozeTriggerButton = ({
  open,
  toggle,
  size = "md",
}: {
  open: boolean;
  toggle: () => void;
  size?: "sm" | "md";
}) => (
  <IconButton
    label="Snooze (b)"
    size={size}
    onClick={toggle}
    active={open}
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    <Clock className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
  </IconButton>
);
