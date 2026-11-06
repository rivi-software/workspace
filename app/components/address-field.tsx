import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { Address } from "~/db/schema";
import { suggestContacts } from "~/lib/mail/actions";
import {
  displayName,
  formatAddress,
  formatAddressList,
  isValidEmail,
  parseAddress,
  parseAddressList,
} from "~/lib/mail/addresses";

import { Avatar, cx } from "./ui";

type Chip = Address & { valid: boolean };

const chipsFrom = (value: string): Chip[] => {
  const { addresses, invalid } = parseAddressList(value);
  const out: Chip[] = addresses.map((a) => ({ ...a, valid: true }));
  const seen = new Set(out.map((c) => c.email));

  for (const raw of invalid) {
    const a = parseAddress(raw);

    if (seen.has(a.email)) {
      continue;
    }

    seen.add(a.email);
    out.push({ ...a, valid: false });
  }

  return out;
};

/** What the form sends: the chips, and what is still being typed, as one address list. */
const serialize = (chips: Chip[], typed: string): string => {
  const list = formatAddressList(chips);
  const rest = typed.trim();

  return [list, rest].filter(Boolean).join(", ");
};

/**
 * A To, Cc or Bcc field as mail clients have it: each address a chip (red when it does not parse), suggestions from
 * the people the person has written to or heard from, Enter, Tab, a comma or a blur to take what was typed, and a
 * hidden input (`name`) that carries the list to the form.
 */
export const AddressField = ({
  name,
  label,
  initial,
  autoFocus,
  onChange,
  className,
}: {
  name: string;
  label: string;
  initial: string;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
  className?: string;
}) => {
  const [chips, setChips] = useState<Chip[]>(() => chipsFrom(initial));
  const [typed, setTyped] = useState("");
  const [suggestions, setSuggestions] = useState<Address[]>([]);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const suggest = useServerFn(suggestContacts);
  const listId = useId();
  const latest = useRef(0);

  // The latest `onChange` and chips, which the effects below read without running again for them.
  const onChangeRef = useRef(onChange);
  const chipsRef = useRef(chips);

  useEffect(() => {
    onChangeRef.current = onChange;
    chipsRef.current = chips;
  });

  // The parent hears of a change in what the field holds, not of a render: an opened reply box is no draft yet.
  const told = useRef(serialize(chipsFrom(initial), ""));
  useEffect(() => {
    const value = serialize(chips, typed);

    if (value === told.current) {
      return;
    }

    told.current = value;
    onChangeRef.current?.(value);
  }, [chips, typed]);

  useEffect(() => {
    const q = typed.trim();

    if (!q) {
      return;
    }

    latest.current += 1;
    const n = latest.current;

    const run = async () => {
      const found = await suggest({ data: { q } });

      if (n !== latest.current) {
        return;
      }

      const have = new Set(chipsRef.current.map((c) => c.email));
      setSuggestions(found.filter((a) => !have.has(a.email)).slice(0, 6));
      setCursor(0);
      setOpen(true);
    };

    const timer = setTimeout(() => {
      void run();
    }, 150);

    return () => clearTimeout(timer);
  }, [typed, suggest]);

  const addChips = (next: Chip[]) => {
    if (!next.length) {
      return;
    }

    setChips((prev) => {
      const have = new Set(prev.map((c) => c.email));

      return [...prev, ...next.filter((c) => !have.has(c.email))];
    });
    setTyped("");
    setSuggestions([]);
    setOpen(false);
  };

  const addTyped = () => addChips(chipsFrom(typed));

  const addSuggestion = (address: Address) =>
    addChips([{ ...address, valid: true }]);

  const remove = (i: number) =>
    setChips((prev) => prev.filter((_, j) => j !== i));

  return (
    <div className={cx("flex items-start gap-2", className)}>
      <label
        htmlFor={`${listId}-input`}
        className="text-muted w-12 shrink-0 pt-1.5 text-sm font-medium"
      >
        {label}
      </label>
      <div className="relative min-w-0 flex-1">
        <div className="border-line bg-input focus-within:border-accent hover:border-line-strong flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md border px-1.5 py-0.5 text-base shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-[border-color,box-shadow] duration-100 focus-within:ring-2 focus-within:ring-(--ring)">
          {chips.map((c, i) => (
            <span
              key={c.email}
              title={formatAddress(c)}
              className={cx(
                "inline-flex h-5 max-w-full items-center gap-1 rounded-[5px] pl-1 pr-0.5 text-sm",
                c.valid ? "bg-hover text-fg" : "bg-red-soft text-red"
              )}
            >
              <Avatar name={displayName(c)} size={14} />
              <span className="truncate">
                {c.valid ? displayName(c) : c.email}
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${c.email}`}
                className="rounded-sm p-0.5 opacity-60 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            ref={input}
            id={`${listId}-input`}
            value={typed}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            placeholder={chips.length ? "" : "name@example.com"}
            onChange={(e) => {
              const { value } = e.currentTarget;
              setTyped(value);

              if (!value.trim()) {
                setSuggestions([]);
              }
            }}
            onFocus={() => suggestions.length && setOpen(true)}
            onBlur={() => {
              setOpen(false);

              if (typed.trim()) {
                addTyped();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && suggestions.length) {
                e.preventDefault();
                setOpen(true);
                setCursor((c) => (c + 1) % suggestions.length);
              } else if (e.key === "ArrowUp" && suggestions.length) {
                e.preventDefault();
                setCursor(
                  (c) => (c - 1 + suggestions.length) % suggestions.length
                );
              } else if (
                e.key === "Enter" ||
                e.key === "Tab" ||
                e.key === "," ||
                e.key === ";"
              ) {
                if (!typed.trim()) {
                  if (e.key !== "Tab") {
                    e.preventDefault();
                  }

                  return;
                }

                e.preventDefault();

                if (open && suggestions[cursor]) {
                  addSuggestion(suggestions[cursor]);
                } else {
                  addTyped();
                }
              } else if (e.key === "Escape" && open) {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === "Backspace" && !typed && chips.length) {
                e.preventDefault();
                remove(chips.length - 1);
              }
            }}
            className="text-fg placeholder:text-subtle h-6 min-w-32 flex-1 bg-transparent text-base outline-none"
          />
          <input type="hidden" name={name} value={serialize(chips, typed)} />
        </div>
        {open && suggestions.length > 0 && (
          <div
            id={listId}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the combobox's popup lists contacts with an avatar under the field; a select or datalist cannot draw either
            role="listbox"
            className="border-line bg-elevated shadow-pop animate-pop-in absolute top-full left-0 z-40 mt-1 w-full max-w-md rounded-lg border p-1"
          >
            {suggestions.map((s, i) => (
              <div
                key={s.email}
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of the contact popup above: it carries an avatar, and an option element only holds text
                role="option"
                tabIndex={-1}
                aria-selected={i === cursor}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addSuggestion(s);
                }}
                onMouseEnter={() => setCursor(i)}
                className={cx(
                  "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-base",
                  i === cursor ? "bg-hover text-fg" : "text-fg"
                )}
              >
                <Avatar name={displayName(s)} size={18} />
                <span className="truncate">{s.name ?? s.email}</span>
                {s.name && (
                  <span className="text-subtle truncate text-sm">
                    {s.email}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {typed && !isValidEmail(typed) && typed.includes("@") && (
          <span className="sr-only">Keep typing a full address.</span>
        )}
      </div>
    </div>
  );
};
