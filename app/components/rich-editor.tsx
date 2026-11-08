import DOMPurify from "dompurify";
import {
  Bold,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Ref } from "react";

import {
  MAX_SIGNATURE_IMAGE_BYTES,
  SIGNATURE_IMAGE_TYPES,
} from "~/lib/mail/signatures";
import { escapeHtml } from "~/lib/text";

import { IconButton, cx, inputClass } from "./ui";

export interface RichEditorHandle {
  focus: () => void;
  /** The markup as it stands. */
  html: () => string;
}

const ALLOWED_PASTE = new Set(
  "a b strong i em u s strike del ul ol li p br div span blockquote h1 h2 h3 h4 pre code hr table thead tbody tr td th img".split(
    " "
  )
);

/** Pasted markup reduced to what the editor writes itself: the structure stays, the styles and scripts go. */
export const cleanPastedHtml = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walk = (node: Element) => {
    for (const child of node.querySelectorAll(":scope > *")) {
      const tag = child.tagName.toLowerCase();

      if (
        tag === "script" ||
        tag === "style" ||
        tag === "meta" ||
        tag === "link" ||
        tag === "head"
      ) {
        child.remove();
        continue;
      }

      walk(child);

      if (!ALLOWED_PASTE.has(tag)) {
        // Keep what it holds, lose the element.
        child.replaceWith(...child.childNodes);
        continue;
      }

      for (const name of child.getAttributeNames()) {
        const value = child.getAttribute(name)?.trim() ?? "";

        const keep =
          (tag === "a" &&
            name === "href" &&
            /^(?:https?:|mailto:)/iu.test(value)) ||
          (tag === "img" && name === "src" && /^https?:/iu.test(value)) ||
          (tag === "img" && name === "alt");

        if (!keep) {
          child.removeAttribute(name);
        }
      }
    }
  };

  walk(doc.body);

  return doc.body.innerHTML;
};

/**
 * What the editor starts from (a reply's or forward's quote of a message that arrived, a draft, a signature), as the
 * browser itself parses it, cleaned by DOMPurify before it reaches the console's own document: unlike a message in
 * its frame, it runs here with the session's rights. The server sanitised the quote already, but with regular
 * expressions; a markup they read otherwise than the browser was script on this origin (CORE-1302). A style element
 * would restyle the console and a form control would post with the composer's form, so they go too.
 */
const editorMarkup = (html: string): string =>
  DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      "style",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
    ],
  });

const isEmptyMarkup = (el: HTMLElement): boolean =>
  !el.textContent?.trim() && !el.querySelector("img");

/** The widest an inserted image shows: a logo under a signature, not a banner. A larger one keeps its pixels. */
const IMAGE_WIDTH = 240;

/** An image file as a `data:` URI with the width it shows at, for an `<img>` the markup carries along. */
const readImage = (file: File): Promise<{ src: string; width: number }> =>
  // oxlint-disable-next-line promise/avoid-new -- FileReader and Image report through events, which a promise has to wrap to be awaited
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(new Error("The image could not be read."))
    );
    reader.addEventListener("load", () => {
      const src = reader.result;

      // A data URL is text; the other kinds of result come only from the other ways to read.
      if (src === null || src instanceof ArrayBuffer) {
        reject(new Error("The image could not be read."));

        return;
      }

      const img = new Image();
      img.addEventListener("load", () =>
        resolve({
          src,
          width: Math.min(IMAGE_WIDTH, img.naturalWidth || IMAGE_WIDTH),
        })
      );
      img.addEventListener("error", () =>
        reject(new Error("That file is not an image this editor can show."))
      );
      img.src = src;
    });

    reader.readAsDataURL(file);
  });

/**
 * One of the browser's editing commands on the focused contentEditable area. `execCommand` is deprecated with nothing
 * to take its place: it is still the one way to change the text that the browser's own undo (Cmd+Z) takes back.
 */
const command = (name: string, value?: string): boolean =>
  // oxlint-disable-next-line typescript/no-deprecated -- no API replaces contentEditable's commands, and only they keep the browser's undo history
  document.execCommand(name, false, value);

/** Whether the selection is bold, a list, and so on, as the commands above see it. */
const commandState = (name: string): boolean =>
  // oxlint-disable-next-line typescript/no-deprecated -- the state of the commands above, which have no replacement either
  document.queryCommandState(name);

/**
 * The rich composer's text: a contentEditable area with a small toolbar (bold, italic, underline, strikethrough,
 * link, lists, quote, clear), the quoted original of a reply folded until asked for, and a hidden input that
 * carries the markup to the form (`name`). The browser's own editing commands do the work; the server sanitises.
 */
export const RichEditor = ({
  name = "html",
  initialHtml,
  placeholder = "Write your message",
  onChange,
  className,
  autoFocus,
  handle,
  onSubmit,
  label = "Message",
  images = false,
  onImageError,
}: {
  name?: string;
  initialHtml: string;
  placeholder?: string;
  onChange?: (html: string) => void;
  className?: string;
  autoFocus?: boolean;
  handle?: Ref<RichEditorHandle>;
  /** ⌘Enter / Ctrl+Enter in the editor. */
  onSubmit?: () => void;
  /** The text area's accessible name. */
  label?: string;
  /** An "Insert image" tool: the file goes into the markup as a `data:` URI (a signature's logo). */
  images?: boolean;
  onImageError?: (message: string) => void;
}) => {
  const area = useRef<HTMLDivElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  const [hasQuote, setHasQuote] = useState(false);
  const [quoteShown, setQuoteShown] = useState(false);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const savedRange = useRef<Range | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  // The latest `autoFocus`, which the markup's effect reads without running again for it.
  const focusOnStart = useRef(autoFocus);

  useEffect(() => {
    focusOnStart.current = autoFocus;
  });

  const sync = useCallback(() => {
    const el = area.current;

    if (!el) {
      return;
    }

    const html = el.innerHTML;

    if (hidden.current) {
      hidden.current.value = html;
    }

    setEmpty(isEmptyMarkup(el));
    onChange?.(html);
  }, [onChange]);

  // The markup goes in once, by hand: React must not own what the person edits.
  useEffect(() => {
    const el = area.current;

    if (!el) {
      return;
    }

    el.innerHTML = editorMarkup(initialHtml);
    setHasQuote(!!el.querySelector(".gmail_quote"));
    setQuoteShown(false);

    if (hidden.current) {
      hidden.current.value = el.innerHTML;
    }

    setEmpty(isEmptyMarkup(el));

    if (focusOnStart.current) {
      el.focus();
      // The caret at the start, where the reply is written, not after the quote.
      const sel = window.getSelection();

      if (sel && el.firstChild) {
        const range = document.createRange();
        range.setStart(el.firstChild, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, [initialHtml]);

  useImperativeHandle(handle, () => ({
    focus: () => area.current?.focus(),
    html: () => area.current?.innerHTML ?? "",
  }));

  // The toolbar's pressed states follow the selection.
  useEffect(() => {
    const read = () => {
      const el = area.current;

      if (
        !el ||
        !el.contains(document.activeElement) ||
        !document.getSelection()?.rangeCount
      ) {
        return;
      }

      const states: Record<string, boolean> = {};

      for (const cmd of [
        "bold",
        "italic",
        "underline",
        "strikeThrough",
        "insertUnorderedList",
        "insertOrderedList",
      ]) {
        try {
          states[cmd] = commandState(cmd);
        } catch {
          states[cmd] = false;
        }
      }

      setActive(states);
    };

    document.addEventListener("selectionchange", read);

    return () => document.removeEventListener("selectionchange", read);
  }, []);

  const exec = (cmd: string, value?: string) => {
    area.current?.focus();
    command(cmd, value);
    sync();
  };

  const openLink = () => {
    const sel = window.getSelection();
    savedRange.current =
      sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const anchor = (sel?.anchorNode?.parentElement ?? null)?.closest("a");
    setLinkUrl(anchor?.getAttribute("href") ?? "");
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkOpen(false);
    const el = area.current;

    if (!el) {
      return;
    }

    el.focus();
    const sel = window.getSelection();

    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }

    if (url) {
      const href = /^(?:https?:|mailto:)/iu.test(url) ? url : `https://${url}`;

      if (sel && !sel.isCollapsed) {
        command("createLink", href);
      } else {
        command(
          "insertHTML",
          `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>&nbsp;`
        );
      }
    } else {
      command("unlink");
    }

    sync();
  };

  const insertImage = async (file: File) => {
    if (!SIGNATURE_IMAGE_TYPES.includes(file.type)) {
      onImageError?.("Choose a PNG, JPEG, GIF or WebP image.");

      return;
    }

    if (file.size > MAX_SIGNATURE_IMAGE_BYTES) {
      onImageError?.(
        `That image is ${Math.ceil(file.size / 1024)} KB; ${MAX_SIGNATURE_IMAGE_BYTES / 1024} KB is the most. Save a smaller one.`
      );

      return;
    }

    try {
      const { src, width } = await readImage(file);
      const el = area.current;

      if (!el) {
        return;
      }

      el.focus();
      const sel = window.getSelection();

      if (savedRange.current && sel) {
        sel.removeAllRanges();
        sel.addRange(savedRange.current);
      }

      const alt = file.name
        .replace(/\.[a-z0-9]+$/iu, "")
        .replaceAll(/[<>"&]/gu, "");

      command("insertHTML", `<img src="${src}" alt="${alt}" width="${width}">`);
      sync();
    } catch (error) {
      onImageError?.(error instanceof Error ? error.message : String(error));
    }
  };

  const tools: (
    | { label: string; icon: React.ReactNode; command: string; key?: string }
    | { gap: string }
  )[] = [
    {
      label: "Bold",
      icon: <Bold className="h-3.5 w-3.5" />,
      command: "bold",
      key: "⌘B",
    },
    {
      label: "Italic",
      icon: <Italic className="h-3.5 w-3.5" />,
      command: "italic",
      key: "⌘I",
    },
    {
      label: "Underline",
      icon: <Underline className="h-3.5 w-3.5" />,
      command: "underline",
      key: "⌘U",
    },
    {
      label: "Strikethrough",
      icon: <Strikethrough className="h-3.5 w-3.5" />,
      command: "strikeThrough",
    },
    { gap: "lists" },
    {
      label: "Bulleted list",
      icon: <List className="h-3.5 w-3.5" />,
      command: "insertUnorderedList",
    },
    {
      label: "Numbered list",
      icon: <ListOrdered className="h-3.5 w-3.5" />,
      command: "insertOrderedList",
    },
    {
      label: "Quote",
      icon: <Quote className="h-3.5 w-3.5" />,
      command: "formatBlock:blockquote",
    },
    { gap: "clear" },
    {
      label: "Clear formatting",
      icon: <RemoveFormatting className="h-3.5 w-3.5" />,
      command: "removeFormat",
    },
  ];

  return (
    <div
      className={cx(
        "rounded-md border border-line bg-input focus-within:border-accent focus-within:ring-2 focus-within:ring-(--ring)",
        className
      )}
    >
      <div className="text-md text-fg relative px-3 py-2.5 leading-6">
        <div
          ref={area}
          contentEditable
          suppressContentEditableWarning
          tabIndex={0}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an input or textarea cannot hold the markup this editor writes; a contenteditable region is the textbox
          role="textbox"
          aria-multiline
          aria-label={label}
          data-placeholder={placeholder}
          data-empty={empty || undefined}
          data-quote-hidden={hasQuote && !quoteShown ? "" : undefined}
          className="rich-editor"
          onInput={sync}
          onBlur={sync}
          onPaste={(e) => {
            const html = e.clipboardData.getData("text/html");
            const text = e.clipboardData.getData("text/plain");

            if (!html && !text) {
              return;
            }

            e.preventDefault();

            if (html) {
              command("insertHTML", cleanPastedHtml(html));
            } else {
              command("insertText", text);
            }

            sync();
          }}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;

            if (mod && e.key === "Enter" && onSubmit) {
              e.preventDefault();
              onSubmit();
            } else if (mod && e.key.toLowerCase() === "k") {
              e.preventDefault();
              openLink();
            }
          }}
        />
        {hasQuote && !quoteShown && (
          <button
            type="button"
            onClick={() => setQuoteShown(true)}
            className="bg-hover text-muted hover:bg-active hover:text-fg mt-2 inline-flex h-5 items-center rounded-full px-2 text-xs"
            aria-label="Show quoted text"
            title="Show quoted text"
          >
            •••
          </button>
        )}
      </div>
      <div className="border-line flex flex-wrap items-center gap-0.5 border-t px-1.5 py-1">
        {tools.map((t) =>
          "gap" in t ? (
            <span key={t.gap} className="bg-line mx-1 h-4 w-px" />
          ) : (
            <IconButton
              key={t.command}
              size="sm"
              label={t.key ? `${t.label} (${t.key})` : t.label}
              active={active[t.command]}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (t.command.startsWith("formatBlock:")) {
                  exec("formatBlock", t.command.split(":")[1]);
                } else {
                  exec(t.command);
                }
              }}
            >
              {t.icon}
            </IconButton>
          )
        )}
        {images && (
          <>
            <IconButton
              size="sm"
              label="Insert image"
              onMouseDown={(e) => {
                e.preventDefault();
                const sel = window.getSelection();
                savedRange.current =
                  sel &&
                  sel.rangeCount &&
                  area.current?.contains(sel.anchorNode)
                    ? sel.getRangeAt(0).cloneRange()
                    : null;
              }}
              onClick={() => imageInput.current?.click()}
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </IconButton>
            <input
              ref={imageInput}
              type="file"
              accept={SIGNATURE_IMAGE_TYPES.join(",")}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";

                if (file) {
                  void insertImage(file);
                }
              }}
            />
          </>
        )}
        <div className="relative">
          <IconButton
            size="sm"
            label="Link (⌘K)"
            active={linkOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (linkOpen ? setLinkOpen(false) : openLink())}
          >
            <Link2 className="h-3.5 w-3.5" />
          </IconButton>
          {linkOpen && (
            <div className="border-line bg-elevated shadow-pop animate-pop-in absolute bottom-full left-0 z-30 mb-1 flex w-72 items-center gap-1 rounded-lg border p-1.5">
              <input
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyLink();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setLinkOpen(false);
                    area.current?.focus();
                  }
                }}
                placeholder="https://"
                aria-label="Link address"
                autoFocus
                className={cx(inputClass, "h-6 text-sm")}
              />
              <button
                type="button"
                onClick={applyLink}
                className="bg-accent text-accent-fg hover:bg-accent-hover h-6 shrink-0 rounded-md px-2 text-sm font-medium"
              >
                {linkUrl.trim() ? "Apply" : "Remove"}
              </button>
            </div>
          )}
        </div>
      </div>
      {/* Only `sync` and the effect above write its value. With `defaultValue`, React wrote the start back on every
          re-render (a hidden input's value is its attribute), so an autosave posted the start, not what was typed. */}
      <input ref={hidden} type="hidden" name={name} />
    </div>
  );
};
