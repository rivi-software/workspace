import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

interface Leaving {
  /** Whether an action under way is taking the conversation out of the view. */
  has: (id: string) => boolean;
  /** Hides the rows until the returned function shows them again: once the list has reloaded, or the action failed. */
  hide: (ids: string[]) => () => void;
}

const LeavingContext = createContext<Leaving | null>(null);

/**
 * The conversations an action is taking out of the list: their rows go the moment it starts, from the list or the
 * open conversation, instead of after the server has answered and every loader on screen has reloaded.
 */
export const MailLeavingProvider = ({ children }: { children: ReactNode }) => {
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());

  const hide = useCallback((ids: string[]) => {
    if (!ids.length) {
      return () => {
        // Nothing was hidden, so there is nothing to show again.
      };
    }

    setLeaving((prev) => new Set([...prev, ...ids]));

    return () =>
      setLeaving((prev) => {
        const next = new Set(prev);

        for (const id of ids) {
          next.delete(id);
        }

        return next;
      });
  }, []);

  const value = useMemo<Leaving>(
    () => ({ has: (id) => leaving.has(id), hide }),
    [leaving, hide]
  );

  return (
    <LeavingContext.Provider value={value}>{children}</LeavingContext.Provider>
  );
};

export const useLeaving = (): Leaving => {
  const ctx = useContext(LeavingContext);

  if (!ctx) {
    throw new Error("useLeaving needs a MailLeavingProvider");
  }

  return ctx;
};
