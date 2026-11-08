import { Eraser, PenLine, Type } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { withCleanup } from "~/lib/cleanup";
import { defined } from "~/lib/guards";

import { Button, Dialog, cx, inputClass } from "../ui";

const INK = "#14183a";

/** The handwriting fonts a typed signature tries, the system's cursive last. */
const SCRIPT_FONTS =
  '"Segoe Script", "Bradley Hand", "Snell Roundhand", "Brush Script MT", "Lucida Handwriting", cursive';

const PAD_W = 600;
const PAD_H = 200;

/**
 * A canvas cut down to the ink on it, with a little room around, as a PNG's base64; null when nothing is on it. At
 * most 1200 by 400 pixels, which the server takes (`isSignaturePng`).
 */
const trimmedPng = (canvas: HTMLCanvasElement): string | null => {
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return null;
  }

  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let [left, top, right, bottom] = [width, height, -1, -1];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (defined(data[(y * width + x) * 4 + 3], "the item") > 16) {
        if (x < left) {
          left = x;
        }

        if (x > right) {
          right = x;
        }

        if (y < top) {
          top = y;
        }

        if (y > bottom) {
          bottom = y;
        }
      }
    }
  }

  if (right < 0) {
    return null;
  }

  const pad = 8;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const w = right - left + 1;
  const h = bottom - top + 1;
  const scale = Math.min(1, 1200 / w, 400 / h);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  defined(out.getContext("2d"), "the result of get context").drawImage(
    canvas,
    left,
    top,
    w,
    h,
    0,
    0,
    out.width,
    out.height
  );

  return out.toDataURL("image/png").replace(/^data:image\/png;base64,/u, "");
};

/** A canvas with its 2D context, or nothing before it is mounted. */
const contextOf = (el: HTMLCanvasElement | null) => {
  const c = el?.getContext("2d");

  if (!el || !c) {
    return null;
  }

  return { el, c };
};

/** Where the pointer is on the pad, in the pad's own units. */
const pointOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
  const rect = e.currentTarget.getBoundingClientRect();

  return {
    x: ((e.clientX - rect.left) / rect.width) * PAD_W,
    y: ((e.clientY - rect.top) / rect.height) * PAD_H,
  };
};

/** A signature drawn with the pointer, or typed and written in a handwriting font. */
export const SignaturePad = ({
  name,
  onChange,
}: {
  /** What a typed signature starts as. */
  name: string;
  onChange: (png: string | null) => void;
}) => {
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState(name);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const inked = useRef(false);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const ctx = () => contextOf(canvas.current);

  const clear = () => {
    const got = ctx();

    if (!got) {
      return;
    }

    got.c.clearRect(0, 0, got.el.width, got.el.height);
    inked.current = false;
    onChangeRef.current(null);
  };

  // A typed signature is written on the canvas whenever it changes; switching mode starts over.
  useEffect(() => {
    const got = contextOf(canvas.current);

    if (!got) {
      return;
    }

    const ratio = window.devicePixelRatio || 1;
    got.el.width = PAD_W * ratio;
    got.el.height = PAD_H * ratio;
    got.c.setTransform(ratio, 0, 0, ratio, 0, 0);
    got.c.clearRect(0, 0, PAD_W, PAD_H);
    inked.current = false;

    if (mode === "type") {
      const text = typed.trim();

      if (!text) {
        return onChangeRef.current(null);
      }

      let size = 64;
      got.c.font = `${size}px ${SCRIPT_FONTS}`;

      while (size > 20 && got.c.measureText(text).width > PAD_W - 40) {
        size -= 2;
        got.c.font = `${size}px ${SCRIPT_FONTS}`;
      }

      got.c.fillStyle = INK;
      got.c.textBaseline = "middle";
      got.c.fillText(text, 20, PAD_H / 2);
      onChangeRef.current(trimmedPng(got.el));
    } else {
      onChangeRef.current(null);
    }
  }, [mode, typed]);

  return (
    <div className="space-y-2">
      <div
        className="flex items-center gap-1"
        role="tablist"
        aria-label="How to sign"
      >
        {(
          [
            ["draw", "Draw", PenLine],
            ["type", "Type", Type],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={cx(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-base transition-colors",
              mode === key
                ? "bg-active text-fg"
                : "text-muted hover:bg-hover hover:text-fg"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        {mode === "draw" && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={clear}>
            <Eraser className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>
      {mode === "type" && (
        <input
          className={inputClass}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Your name as you sign it"
          maxLength={60}
          autoFocus
        />
      )}
      <div className="border-line relative rounded-md border bg-white">
        <canvas
          ref={canvas}
          className={cx(
            "block aspect-[3/1] w-full",
            mode === "draw" && "cursor-crosshair touch-none"
          )}
          aria-label={
            mode === "draw"
              ? "Draw your signature here"
              : "Your typed signature"
          }
          onPointerDown={(e) => {
            if (mode !== "draw") {
              return;
            }

            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = pointOf(e);
          }}
          onPointerMove={(e) => {
            const from = drawing.current;
            const got = ctx();

            if (!from || !got) {
              return;
            }

            const to = pointOf(e);
            got.c.strokeStyle = INK;
            got.c.lineWidth = 2.6;
            got.c.lineCap = "round";
            got.c.lineJoin = "round";
            got.c.beginPath();
            got.c.moveTo(from.x, from.y);
            got.c.lineTo(to.x, to.y);
            got.c.stroke();
            drawing.current = to;
            inked.current = true;
          }}
          onPointerUp={() => {
            drawing.current = null;
            const got = ctx();

            if (got && inked.current) {
              onChangeRef.current(trimmedPng(got.el));
            }
          }}
        />
        <div className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-black/20" />
      </div>
    </div>
  );
};

/** A dialog that asks for a signature and hands it back once adopted. */
export const SignatureDialog = ({
  open,
  name,
  title = "Your signature",
  submitLabel = "Use this signature",
  note,
  onClose,
  onAdopt,
}: {
  open: boolean;
  name: string;
  title?: string;
  submitLabel?: string;
  note?: string;
  onClose: () => void;
  /** Takes the signature; says its own failure, since the dialog only waits on it. */
  onAdopt: (png: string) => void | Promise<void>;
}) => {
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = async () => {
    if (!png) {
      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        await onAdopt(png);
      },
      () => setBusy(false)
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      className="w-[min(94vw,640px)]"
    >
      {open && (
        <div className="space-y-3">
          <SignaturePad name={name} onChange={setPng} />
          {note && <p className="text-muted text-sm">{note}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!png}
              loading={busy}
              onClick={() => {
                void adopt();
              }}
            >
              {submitLabel}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
};
