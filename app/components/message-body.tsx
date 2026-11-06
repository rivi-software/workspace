import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { mailDocument, mailReading } from "~/lib/mail/sanitize";
import type { MailReading } from "~/lib/mail/sanitize";
import { quoteStart, splitLinks } from "~/lib/text";

import { useIsDark } from "./theme";
import { cx } from "./ui";

/**
 * The HTML part of a message in a sandboxed iframe: the markup was sanitised in the loader, the document the iframe
 * gets carries a strict CSP (`mailDocument`), and the sandbox runs no script. `allow-same-origin` is what lets the
 * page measure the document's height; with scripts off the message cannot use it, and every link opens a new tab.
 * The frame stays empty until the reading is known (`mailReading`, on the client), so it loads once, in its theme.
 */
export const HtmlMessage = ({
  html,
  origin,
  loadImages,
  reading,
  title = "Message",
}: {
  html: string;
  origin: string;
  loadImages: boolean;
  reading: MailReading | null;
  title?: string;
}) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const doc = useMemo(
    () =>
      reading
        ? mailDocument(html, { origin, loadRemoteImages: loadImages, reading })
        : null,
    [html, origin, loadImages, reading]
  );

  // A layout effect runs in the commit that set `srcDoc`, before the navigation this starts can replace the frame's
  // document: the one there now is about:blank, or the previous `doc`'s, never this message's.
  useLayoutEffect(() => {
    const el = frame.current;

    if (!el || !doc) {
      return;
    }

    const stale = el.contentDocument;
    const ended = new AbortController();
    let observed: Document | null = null;
    let next = 0;

    const measure = () => {
      const root = observed?.documentElement;

      if (!root) {
        return;
      }

      // The document's own height: scrollHeight never drops below the frame's, so a frame could only grow.
      const content = Math.ceil(root.getBoundingClientRect().height);

      // A table wider than the frame scrolls sideways, and on most systems its scrollbar takes height of its own.
      const scrollbar = Math.max(
        0,
        (el.contentWindow?.innerHeight ?? 0) - root.clientHeight
      );

      setHeight(Math.max(20, content + scrollbar));
    };

    const observer =
      "ResizeObserver" in window ? new ResizeObserver(() => measure()) : null;

    // The frame's `load` waits for every image, and a tracking pixel that never answers holds it for good (CORE-1237):
    // the message is measured once its document is parsed, and followed as its images arrive.
    const follow = () => {
      cancelAnimationFrame(next);
      const current = el.contentDocument;

      if (!current) {
        return;
      }

      if (current === stale) {
        next = requestAnimationFrame(follow);

        return;
      }

      if (current.readyState === "loading") {
        current.addEventListener("DOMContentLoaded", follow, {
          once: true,
          signal: ended.signal,
        });

        return;
      }

      if (current !== observed) {
        observer?.disconnect();
        observer?.observe(current.body);
        observed = current;
      }

      measure();
    };

    follow();
    el.addEventListener("load", follow, { signal: ended.signal });

    return () => {
      ended.abort();
      cancelAnimationFrame(next);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <iframe
      ref={frame}
      title={title}
      srcDoc={doc ?? undefined}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      // Rounded for the light sheet a message read light gets in the dark theme; transparent otherwise.
      className="block w-full rounded-md border-0 bg-transparent"
      style={{ height }}
    />
  );
};

/**
 * A signature as its recipients read it: the sanitised markup in the same frame as a message, in the reader's theme,
 * its own images (`data:` URIs) and any it links to shown.
 */
export const SignaturePreview = ({
  html,
  className,
}: {
  html: string;
  className?: string;
}) => {
  const dark = useIsDark();

  const reading = useMemo(
    () => (dark === null ? null : mailReading(html, { dark })),
    [html, dark]
  );

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className={className}>
      <HtmlMessage
        html={html}
        origin={origin}
        loadImages
        reading={reading}
        title="Signature"
      />
    </div>
  );
};

/** Text with its URLs and addresses as links, as React nodes (no HTML is injected). */
const Linkified = ({ text }: { text: string }) => (
  <>
    {splitLinks(text).map((p, i) =>
      p.href ? (
        <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
          {p.text}
        </a>
      ) : (
        <span key={i}>{p.text}</span>
      )
    )}
  </>
);

/** The plain-text part: links clickable, the quoted earlier messages folded behind a button. */
export const TextMessage = ({ text }: { text: string }) => {
  const [showQuote, setShowQuote] = useState(false);
  const lines = text.replaceAll(/\r\n?/gu, "\n").split("\n");
  const start = quoteStart(lines);
  const own = (start < 0 ? lines : lines.slice(0, start)).join("\n").trimEnd();
  const quoted = start < 0 ? "" : lines.slice(start).join("\n").trim();

  return (
    <div className="text-md text-fg leading-6">
      <pre className="[&_a]:text-accent font-sans break-words whitespace-pre-wrap [&_a]:underline [&_a]:underline-offset-2">
        <Linkified text={own} />
      </pre>
      {quoted && (
        <>
          <button
            type="button"
            onClick={() => setShowQuote((s) => !s)}
            aria-expanded={showQuote}
            className={cx(
              "mt-3 inline-flex h-5 items-center rounded-full bg-hover px-2 text-xs text-muted hover:bg-active hover:text-fg"
            )}
          >
            {showQuote ? "Hide quoted text" : "Show quoted text"}
          </button>
          {showQuote && (
            <pre className="border-line text-muted mt-2 border-l-2 pl-3 font-sans break-words whitespace-pre-wrap [&_a]:underline">
              <Linkified text={quoted} />
            </pre>
          )}
        </>
      )}
    </div>
  );
};
