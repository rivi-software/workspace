import { createLink, useHydrated } from "@tanstack/react-router";
import { Check, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AnchorHTMLAttributes, ReactNode, Ref } from "react";

import { defined } from "~/lib/guards";

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

/* ---------- buttons ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type ButtonSize = "sm" | "md";

export const buttonClass = (
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string
) =>
  cx(
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-100 ease-out active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50",
    size === "sm" ? "h-6 px-2 text-sm" : "h-7 px-2.5 text-base",
    {
      primary:
        "bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_1px_rgb(0_0_0/0.08)] hover:bg-accent-hover",
      secondary:
        "border border-line bg-elevated text-fg shadow-[0_1px_1px_rgb(0_0_0/0.04)] hover:border-line-strong hover:tint-hover",
      ghost: "text-muted hover:bg-hover hover:text-fg",
      danger: "bg-red text-white hover:brightness-110",
    }[variant],
    className
  );

export const Button = ({
  ref,
  children,
  variant = "secondary",
  size = "md",
  loading,
  className,
  disabled,
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) => (
  <button
    ref={ref}
    // oxlint-disable-next-line react/button-has-type -- `type` is the prop's own value, one of the three a button takes, and "button" unless the caller says otherwise
    type={type}
    className={buttonClass(variant, size, className)}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    {...rest}
  >
    {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
    {children}
  </button>
);

const LinkButtonBase = ({
  ref,
  children,
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  ref?: Ref<HTMLAnchorElement>;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) => (
  <a ref={ref} className={buttonClass(variant, size, className)} {...rest}>
    {children}
  </a>
);

/** A router link styled as a button: `<LinkButton to="/mail/compose" variant="primary">`. */
export const LinkButton = createLink(LinkButtonBase);

export const IconButton = ({
  children,
  label,
  className,
  size = "md",
  active,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: ButtonSize;
  active?: boolean;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={cx(
      "inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-hover hover:text-fg disabled:opacity-40",
      size === "sm" ? "h-6 w-6" : "h-7 w-7",
      active && "bg-active text-fg",
      className
    )}
    {...rest}
  >
    {children}
  </button>
);

export const Kbd = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <kbd
    className={cx(
      "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line bg-elevated px-1 font-sans text-2xs font-medium text-subtle shadow-[0_1px_0_var(--border)]",
      className
    )}
  >
    {children}
  </kbd>
);

/* ---------- form controls ---------- */

/** A text field's look without its width; `inputClass` is this at full width. */
export const fieldClass =
  "h-7 rounded-md border border-line bg-input px-2 text-base text-fg shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-[width,border-color,box-shadow] duration-100 placeholder:text-subtle hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-(--ring) disabled:opacity-50";

export const inputClass = `${fieldClass} w-full`;

export const textareaClass =
  "w-full resize-y rounded-md border border-line bg-input px-2.5 py-2 text-base leading-5 text-fg shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-[border-color,box-shadow] duration-100 placeholder:text-subtle hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-(--ring)";

export const selectClass =
  "h-7 rounded-md border border-line bg-input px-2 text-base text-fg shadow-[0_1px_1px_rgb(0_0_0/0.03)] hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-(--ring)";

/** Where the link that clears a `SearchField` sits: over the field's right edge. */
export const searchClearClass =
  "absolute right-1.5 rounded-sm p-0.5 text-subtle hover:text-fg";

/**
 * The search of a list header: a GET form that keeps the view's own params. On a narrow pane it is the magnifier
 * alone, growing into a field on focus (`/` focuses it) and staying open while it holds a search; `className` names
 * the container width from which it is always a field (`@sm:w-40 @3xl:w-64`).
 */
export const SearchField = ({
  action,
  label,
  placeholder,
  hint,
  value,
  hidden,
  clear,
  className,
}: {
  action: string;
  label: string;
  placeholder: string;
  /** The tooltip: the operators the search understands. */
  hint?: string;
  value: string;
  /** The view's own params, posted with the search. */
  hidden?: Record<string, string>;
  /** The link that clears the search, shown while it holds one. */
  clear?: ReactNode;
  className?: string;
}) => (
  <form
    method="get"
    action={action}
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the form itself is the search landmark (a search form carries role="search"); `<search>` would be one more wrapper, and the form keeps its own layout
    role="search"
    className="relative flex items-center"
  >
    {Object.entries(hidden ?? {}).map(([name, v]) => (
      <input key={name} type="hidden" name={name} value={v} />
    ))}
    <Search className="text-subtle pointer-events-none absolute left-2 h-3.5 w-3.5" />
    <input
      name="q"
      type="search"
      defaultValue={value}
      placeholder={placeholder}
      aria-label={label}
      title={hint}
      className={cx(
        fieldClass,
        "w-7 pl-7 focus:w-40",
        value && "min-w-40 pr-7",
        className
      )}
    />
    {value && clear}
  </form>
);

/** A 14px checkbox: hairline box, `accent-soft` with an accent tick when on. A native input. */
export const Checkbox = ({
  className,
  ...rest
}: Omit<React.ComponentProps<"input">, "type">) => (
  <span className={cx("relative inline-flex h-3.5 w-3.5 shrink-0", className)}>
    <input
      type="checkbox"
      className="peer border-line-strong bg-input checked:border-accent/40 checked:bg-accent-soft h-3.5 w-3.5 cursor-default appearance-none rounded-[4px] border shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:outline-none disabled:opacity-50"
      {...rest}
    />
    <Check
      aria-hidden
      strokeWidth={3}
      className="text-accent pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 opacity-0 transition-opacity duration-100 peer-checked:opacity-100"
    />
  </span>
);

export const Field = ({
  label,
  children,
  hint,
  className,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) => (
  <label className={cx("block", className)}>
    <span className="text-muted mb-1 block text-sm font-medium">{label}</span>
    {children}
    {hint && <span className="text-subtle mt-1 block text-xs">{hint}</span>}
  </label>
);

/* ---------- surfaces ---------- */

export const Section = ({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section className={cx("min-w-0", className)}>
    {(title || actions) && (
      <header className="mb-2 flex h-7 items-center justify-between gap-2">
        <h2 className="text-subtle text-sm font-medium">{title}</h2>
        <div className="flex items-center gap-1">{actions}</div>
      </header>
    )}
    <div className="border-line bg-elevated rounded-lg border">{children}</div>
  </section>
);

export const ViewHeader = ({
  title,
  count,
  left,
  children,
  className,
}: {
  title: ReactNode;
  count?: number;
  left?: ReactNode;
  children?: ReactNode;
  className?: string;
}) => (
  <div
    className={cx(
      "flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 max-lg:pl-12 group-data-[collapsed]/main:pl-12",
      className
    )}
  >
    {left}
    <h1 className="text-fg min-w-0 shrink truncate text-base font-medium">
      {title}
    </h1>
    {count !== undefined && (
      <span className="tnum text-subtle text-sm">{count}</span>
    )}
    <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
      {children}
    </div>
  </div>
);

export const Pill = ({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "amber" | "red";
  className?: string;
}) => {
  const tones = {
    neutral: "bg-hover text-muted",
    accent: "bg-accent-soft text-accent",
    amber: "bg-amber-soft text-amber",
    red: "bg-red-soft text-red",
  }[tone];

  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1 rounded-[5px] px-1.5 text-xs font-medium",
        tones,
        className
      )}
    >
      {children}
    </span>
  );
};

/** 2 ** 32: the hash wraps like an unsigned 32-bit integer. */
const UINT32_RANGE = 2 ** 32;

const avatarHues = [212, 262, 330, 16, 150, 190, 40, 290];

const hueFor = (seed: string) => {
  let h = 0;

  for (let i = 0; i < seed.length; i += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- the hash runs over UTF-16 code units, so every name keeps the colour it has had
    h = (h * 31 + seed.charCodeAt(i)) % UINT32_RANGE;
  }

  return avatarHues[h % avatarHues.length];
};

export const Avatar = ({
  name,
  size = 20,
  className,
}: {
  name?: string | null;
  size?: number;
  className?: string;
}) => {
  const label = (name ?? "?").trim();

  const initials =
    label
      .split(/[\s@._-]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => defined(s[0], "the first item").toUpperCase())
      .join("") || "?";

  const hue = hueFor(label);

  return (
    <span
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold",
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        // The hue is the name's; the lightness is the theme's (`--avatar-*` in app.css).
        background: `hsl(${hue} 50% var(--avatar-bg-l))`,
        color: `hsl(${hue} 50% var(--avatar-fg-l))`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
};

export const Empty = ({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) => (
  <div className="animate-fade-in flex flex-col items-center justify-center px-6 py-16 text-center">
    {icon && (
      <div className="border-line bg-elevated text-subtle mb-3 flex h-9 w-9 items-center justify-center rounded-lg border">
        {icon}
      </div>
    )}
    <div className="text-md text-fg font-medium">{title}</div>
    {children && (
      <p className="text-muted mt-1 max-w-sm text-base">{children}</p>
    )}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

/** The date column of a mail list: the time today, the weekday this week, else the date. */
export const listDate = (iso: string): string => {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();

  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const days = (now.getTime() - d.getTime()) / 86_400_000;

  if (days < 6 && days > 0) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }

  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const stampText = (iso: string, relative: boolean): string =>
  relative
    ? listDate(iso)
    : new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

export const Timestamp = ({
  iso,
  className,
  relative = true,
}: {
  iso: string;
  className?: string;
  relative?: boolean;
}) => {
  // In the reader's time zone and locale, so only once hydrated: the server renders in UTC, and React keeps the
  // server's text of a node it hydrates.
  const hydrated = useHydrated();
  const d = new Date(iso);

  return (
    <time
      dateTime={iso}
      title={hydrated ? d.toLocaleString() : undefined}
      className={cx("tnum whitespace-nowrap", className)}
    >
      {hydrated ? stampText(iso, relative) : null}
    </time>
  );
};

/* ---------- inline notices ---------- */

export const Notice = ({
  tone = "neutral",
  children,
  onDismiss,
  className,
}: {
  tone?: "neutral" | "error" | "success";
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) => {
  const tones = {
    neutral: "border-line bg-sidebar text-muted",
    error: "border-red/30 bg-red-soft text-red",
    success: "border-accent/30 bg-accent-soft text-accent",
  }[tone];

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-base animate-rise-in",
        tones,
        className
      )}
    >
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="-mr-1 rounded-sm p-0.5 opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};

/**
 * Whether an event in a menu chose an item that closes it. A submit button ("Sign out") leaves it open: closing
 * takes the button's form out of the page before the browser acts on the press, and a form that has left the
 * page is not submitted. The submission loads another page anyway.
 */
const closesMenu = (target: EventTarget): boolean => {
  const item =
    target instanceof Element ? target.closest('[role="menuitem"]') : null;

  return (
    !!item && !(item instanceof HTMLButtonElement && item.type === "submit")
  );
};

/* ---------- a small menu (the account menu, a message's "more") ---------- */

/**
 * A menu on a trigger: opens on click, closes on Escape, on an outside press and after an item is chosen.
 * Items are buttons or links with `role="menuitem"`; ↑ ↓ move between them.
 */
export const Menu = ({
  renderTrigger,
  children,
  align = "end",
  label,
  className,
  menuClassName,
}: {
  renderTrigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  label: string;
  className?: string;
  menuClassName?: string;
}) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) {
        setOpen(false);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        root.current?.querySelector<HTMLElement>("button, a")?.focus();

        return;
      }

      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
        return;
      }

      const items = [
        ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
          []),
      ];

      if (!items.length) {
        return;
      }

      e.preventDefault();
      const active = document.activeElement;
      const i = active instanceof HTMLElement ? items.indexOf(active) : -1;

      const next =
        e.key === "ArrowDown"
          ? (i + 1) % items.length
          : (i <= 0 ? items.length : i) - 1;

      defined(items[next], "the item").focus();
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    const first = root.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus({ preventScroll: true });

    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={cx("relative", className)}>
      {renderTrigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          tabIndex={-1}
          className={cx(
            "absolute z-40 mt-1 min-w-44 rounded-lg border border-line bg-elevated p-1 shadow-pop animate-pop-in",
            align === "end" ? "right-0" : "left-0",
            menuClassName
          )}
          // A chosen item closes the menu, whether pressed or activated with Enter or Space.
          onClick={(e) => {
            if (closesMenu(e.target)) {
              setOpen(false);
            }
          }}
          onKeyUp={(e) => {
            if ((e.key === "Enter" || e.key === " ") && closesMenu(e.target)) {
              setOpen(false);
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};

export const MenuItem = ({
  children,
  icon,
  className,
  danger,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  danger?: boolean;
}) => (
  <button
    type="button"
    role="menuitem"
    className={cx(
      "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-base transition-colors duration-75 hover:bg-hover focus:outline-none focus-visible:bg-hover",
      danger ? "text-red" : "text-fg",
      className
    )}
    {...rest}
  >
    {icon && (
      <span className="text-muted flex w-4 items-center justify-center">
        {icon}
      </span>
    )}
    <span className="flex-1 truncate">{children}</span>
  </button>
);

const MenuLinkBase = ({
  ref,
  children,
  icon,
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  ref?: Ref<HTMLAnchorElement>;
  icon?: ReactNode;
}) => (
  <a
    ref={ref}
    role="menuitem"
    className={cx(
      "flex h-7 w-full items-center gap-2 rounded-md px-2 text-base text-fg transition-colors duration-75 hover:bg-hover focus:outline-none focus-visible:bg-hover",
      className
    )}
    {...rest}
  >
    {icon && (
      <span className="text-muted flex w-4 items-center justify-center">
        {icon}
      </span>
    )}
    <span className="flex-1 truncate">{children}</span>
  </a>
);

export const MenuLink = createLink(MenuLinkBase);

/** A menu item that is a plain link (a download, another site), outside the router. */
export const MenuAnchor = MenuLinkBase;

export const MenuSeparator = ({ className }: { className?: string }) => (
  <hr className={cx("my-1 border-t border-line", className)} />
);

/* ---------- a popover: a panel on a trigger that stays open while it is used (a label picker, a snooze menu) ---------- */

/**
 * Like `Menu`, but the panel holds controls rather than items: it closes on Escape, on an outside press or when
 * the panel asks (`close`), not when something in it is pressed. Controlled when `open` is given.
 */
export const Popover = ({
  renderTrigger,
  children,
  align = "end",
  label,
  className,
  panelClassName,
  open: controlled,
  onOpenChange,
}: {
  renderTrigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: "start" | "end";
  label: string;
  className?: string;
  panelClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;

  const setOpen = (next: boolean) => {
    if (controlled === undefined) {
      setOwn(next);
    }

    onOpenChange?.(next);
  };

  const root = useRef<HTMLDivElement>(null);
  // The listeners below call the current `setOpen`, so a parent's new `onOpenChange` is used without binding them
  // again (and without moving the focus back into the panel).
  const setOpenRef = useRef(setOpen);

  useEffect(() => {
    setOpenRef.current = setOpen;
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) {
        setOpenRef.current(false);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }

      e.stopPropagation();
      setOpenRef.current(false);
      root.current?.querySelector<HTMLElement>("button, a")?.focus();
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);

    const first = root.current?.querySelector<HTMLElement>(
      "[data-popover] input, [data-popover] button, [data-popover] a"
    );

    first?.focus({ preventScroll: true });

    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={root} className={cx("relative", className)}>
      {renderTrigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          data-popover
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a non-modal panel that sits beside its trigger and stays open while it is used; `<dialog>` brings the browser's own box, modal or top-layer behaviour
          role="dialog"
          aria-label={label}
          className={cx(
            "absolute z-40 mt-1 min-w-56 rounded-lg border border-line bg-elevated p-1 shadow-pop animate-pop-in",
            align === "end" ? "right-0" : "left-0",
            panelClassName
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
};

/* ---------- a modal dialog on the native element ---------- */

export const Dialog = ({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;

    if (!el) {
      return;
    }

    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `title` is a ReactNode: only a string can name the dialog
      aria-label={typeof title === "string" ? title : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx(
        "m-auto w-[min(92vw,480px)] rounded-xl border border-line bg-elevated p-0 text-fg shadow-dialog backdrop:bg-black/30 backdrop:backdrop-blur-[1px] open:animate-pop-in",
        className
      )}
    >
      <div className="border-line flex h-11 items-center justify-between gap-2 border-b px-4">
        <h2 className="text-md font-medium">{title}</h2>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
};
