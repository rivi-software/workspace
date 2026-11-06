import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

interface Selection {
  selected: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  toggle: (id: string, on?: boolean) => void;
  set: (ids: Iterable<string>) => void;
  clear: () => void;
}

const SelectionContext = createContext<Selection | null>(null);

/** Which rows of the list are selected: the list ticks them, the toolbar and the shortcuts act on them. */
export const MailSelectionProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const toggle = useCallback((id: string, on?: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const want = on ?? !next.has(id);

      if (want) {
        next.add(id);
      } else {
        next.delete(id);
      }

      return next;
    });
  }, []);

  const set = useCallback(
    (ids: Iterable<string>) => setSelected(new Set(ids)),
    []
  );

  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo<Selection>(
    () => ({
      selected,
      isSelected: (id) => selected.has(id),
      toggle,
      set,
      clear,
    }),
    [selected, toggle, set, clear]
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
};

export const useSelection = (): Selection => {
  const ctx = useContext(SelectionContext);

  if (!ctx) {
    throw new Error("useSelection needs a MailSelectionProvider");
  }

  return ctx;
};
