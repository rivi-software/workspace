import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { defined } from "~/lib/guards";

import { cx } from "./ui";

export interface ToastInput {
  message: ReactNode;
  /** A button on the toast (Undo, View); pressing it dismisses the toast without `onExpire`. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it goes; 0 keeps it until dismissed. */
  duration?: number;
  /** Runs when the toast's time is up, or when it is closed by hand: what the toast was holding back. */
  onExpire?: () => void;
  /** What to post if the page is left before `onExpire` ran (`navigator.sendBeacon`), so a held send still goes. */
  beacon?: () => { url: string; body: FormData } | null;
  tone?: "neutral" | "error";
  /** The toast's action is an undo, which `z` can press. */
  undo?: boolean;
}

type Toast = ToastInput & { id: number };

interface ToastApi {
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
  /** Press the latest toast's undo, if one is showing. */
  undo: () => boolean;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 6000;

/** Toasts at the bottom of the console: a few at a time, newest last; the undo of the latest answers `z`. */
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const live = useRef<Toast[]>([]);
  const next = useRef(1);

  useEffect(() => {
    live.current = toasts;
  });

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);

    if (timer) {
      clearTimeout(timer);
    }

    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const expire = useCallback(
    (id: number) => {
      const toast = live.current.find((t) => t.id === id);
      remove(id);
      toast?.onExpire?.();
    },
    [remove]
  );

  const show = useCallback(
    (input: ToastInput) => {
      const id = next.current;
      next.current += 1;
      const duration = input.duration ?? DEFAULT_DURATION;
      setToasts((list) => [...list.slice(-2), { ...input, id }]);

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => expire(id), duration)
        );
      }

      return id;
    },
    [expire]
  );

  const undo = useCallback(() => {
    const latest = live.current.toReversed().find((t) => t.undo && t.action);

    if (!latest) {
      return false;
    }

    remove(latest.id);
    defined(latest.action, "the action").onClick();

    return true;
  }, [remove]);

  // A held send goes out even if the tab is closed during its countdown.
  useEffect(() => {
    const onHide = () => {
      for (const t of live.current) {
        const beacon = t.beacon?.();

        if (beacon) {
          navigator.sendBeacon(beacon.url, beacon.body);
        }
      }
    };

    window.addEventListener("pagehide", onHide);

    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ show, dismiss: remove, undo }),
    [show, remove, undo]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="bottom-dock pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4 print:hidden"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an `output` holds phrasing content only; a toast's message is any node beside its buttons
            role="status"
            className={cx(
              "pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border px-3 py-2 text-base shadow-dialog animate-rise-in",
              t.tone === "error"
                ? "border-red/30 bg-red-soft text-red"
                : "border-line-strong bg-fg text-bg dark:bg-elevated dark:text-fg"
            )}
          >
            <div className="min-w-0 flex-1">{t.message}</div>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  remove(t.id);
                  defined(t.action, "the action").onClick();
                }}
                className="text-accent-hover dark:text-accent shrink-0 rounded-md px-1.5 py-0.5 font-medium underline-offset-2 hover:underline"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => expire(t.id)}
              aria-label="Dismiss"
              className="shrink-0 rounded-sm p-0.5 opacity-60 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastApi => {
  const api = useContext(ToastContext);

  if (!api) {
    throw new Error("useToast needs a ToastProvider");
  }

  return api;
};
