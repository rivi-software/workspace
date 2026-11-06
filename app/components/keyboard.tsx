import { useEffect, useRef } from "react";

import { defined } from "~/lib/guards";

const isTyping = (e: KeyboardEvent) => {
  const t = e.target;

  if (!(t instanceof Element)) {
    return false;
  }

  const tag = t.tagName;

  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (t instanceof HTMLElement && t.isContentEditable) ||
    !!t.closest("dialog, [role=dialog], [role=menu]")
  );
};

export interface Shortcut {
  /** A single key ("c", "/"), a chord sequence ("g i") or a modifier combo ("mod+k": ⌘ on macOS, Ctrl elsewhere). */
  keys: string;
  run: () => void;
  allowInInput?: boolean;
}

/** Global shortcuts, Gmail-style: single keys outside text fields, chords that start with "g". */
export const useShortcuts = (shortcuts: Shortcut[]) => {
  const ref = useRef(shortcuts);

  useEffect(() => {
    ref.current = shortcuts;
  });

  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open dialog takes Escape itself (its cancel event); a shortcut's preventDefault would stop that.
      if (e.key === "Escape" && document.querySelector("dialog[open]")) {
        return;
      }

      const typing = isTyping(e);
      const mod = e.metaKey || e.ctrlKey;

      for (const s of ref.current) {
        if (!s.keys.includes("+")) {
          continue;
        }

        const [m, key] = s.keys.split("+");

        if (
          m === "mod" &&
          mod &&
          e.key.toLowerCase() === key &&
          (s.allowInInput || !typing)
        ) {
          e.preventDefault();
          s.run();

          return;
        }
      }

      if (mod || e.altKey) {
        return;
      }

      const { key } = e;

      if (pending.current) {
        const chord = `${pending.current} ${key}`;
        pending.current = null;

        if (timer.current) {
          clearTimeout(timer.current);
        }

        const hit = ref.current.find(
          (s) => s.keys === chord && (s.allowInInput || !typing)
        );

        if (hit) {
          e.preventDefault();
          hit.run();

          return;
        }
      }

      if (typing) {
        const hit = ref.current.find((s) => s.keys === key && s.allowInInput);

        if (hit) {
          e.preventDefault();
          hit.run();
        }

        return;
      }

      if (ref.current.some((s) => s.keys.startsWith(`${key} `))) {
        pending.current = key;
        timer.current = setTimeout(() => (pending.current = null), 800);

        return;
      }

      const hit = ref.current.find((s) => s.keys === key);

      if (hit) {
        e.preventDefault();
        hit.run();
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, []);
};

/** Esc out of a text field so the single-key shortcuts work again. */
export const leaveField = () => {
  const el = document.activeElement;

  if (
    el instanceof HTMLElement &&
    (el.matches("input, textarea, select") || el.isContentEditable)
  ) {
    el.blur();
  }
};

/** The row to focus after `current` (-1: none yet), `delta` on, kept inside the list; from none, the first going down and the last going up. */
const nextIndex = (current: number, delta: number, count: number) => {
  if (current === -1) {
    return delta > 0 ? 0 : count - 1;
  }

  return Math.min(count - 1, Math.max(0, current + delta));
};

const move = (root: HTMLElement | null, delta: number) => {
  if (!root) {
    return;
  }

  const rows = [...root.querySelectorAll<HTMLElement>("[data-row]")];

  if (!rows.length) {
    return;
  }

  const active = document.activeElement;
  const current = active instanceof HTMLElement ? rows.indexOf(active) : -1;
  const row = defined(rows[nextIndex(current, delta, rows.length)], "the item");

  row.focus();
  row.scrollIntoView({ block: "nearest" });
};

/** j / k walk the rows of a list (`[data-row]` anchors), Enter opens the focused one; off while something else owns j and k. */
export const useListNavigation = (
  container: React.RefObject<HTMLElement | null>,
  enabled = true
) => {
  const step = (delta: number) => {
    if (enabled) {
      move(container.current, delta);
    }
  };

  useShortcuts([
    { keys: "j", run: () => step(1) },
    { keys: "k", run: () => step(-1) },
    { keys: "ArrowDown", run: () => step(1) },
    { keys: "ArrowUp", run: () => step(-1) },
  ]);
};
