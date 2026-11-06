import { Loader2 } from "lucide-react";
import type { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { defined } from "~/lib/guards";

import { Notice } from "../ui";

/** A page as shown (rotation applied): its size in PDF points, and how many CSS pixels a point takes on screen. */
export interface ShownPage {
  width: number;
  height: number;
  scale: number;
}

/** What of pdf.js the signing pages use. */
interface PdfJs {
  getDocument: typeof getDocument;
  GlobalWorkerOptions: typeof GlobalWorkerOptions;
}

let loading: Promise<PdfJs> | null = null;

/** pdf.js and its worker, loaded once and only in the browser: the signing pages are the only ones that need them. */
const loadPdfJs = (): Promise<PdfJs> => {
  // The server build leaves pdf.js out altogether: the Worker never draws a page.
  loading ??= import.meta.env.SSR
    ? Promise.reject(new Error("pdf.js runs in the browser"))
    : Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]).then(([lib, worker]) => {
        lib.GlobalWorkerOptions.workerSrc = worker.default;

        return lib;
      });

  return loading;
};

/** The next frame, which is when the canvases a render just placed exist. */
const nextFrame = (): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- requestAnimationFrame reports through a callback, which a promise has to wrap to be awaited
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });

/** The canvas pixels a page is drawn at across, whatever its width on screen. */
const RENDER_WIDTH = 1400;

/**
 * A PDF's pages, one under the other at the width of their column, drawn by pdf.js from `src` (a same-origin address
 * the session or the customer's pass opens). `renderOverlay` draws on each page in a layer of its exact size, which is
 * where fields are placed and filled: a field's box is a fraction of that layer.
 */
export const PdfPages = ({
  src,
  renderOverlay,
  onPages,
}: {
  src: string;
  renderOverlay?: (page: number, shown: ShownPage) => ReactNode;
  onPages?: (count: number) => void;
}) => {
  const [pages, setPages] = useState<
    | {
        number: number;
        width: number;
        height: number;
      }[]
    | null
  >(null);

  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const column = useRef<HTMLDivElement | null>(null);
  const onPagesRef = useRef(onPages);

  useEffect(() => {
    onPagesRef.current = onPages;
  });

  const [shownSrc, setShownSrc] = useState(src);

  // Another file starts from nothing: its pages are not the last one's.
  if (shownSrc !== src) {
    setShownSrc(src);
    setPages(null);
    setFailed(false);
  }

  useEffect(() => {
    const el = column.current;

    if (!el) {
      return;
    }

    const observer = new ResizeObserver(([entry]) =>
      setWidth(defined(entry, "the entry").contentRect.width)
    );

    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Aborted when the file changes or the page goes: the drawing stops and pdf.js lets go of the document.
    const drawing = new AbortController();
    const { signal } = drawing;
    (async () => {
      try {
        const lib = await loadPdfJs();

        if (signal.aborted) {
          return;
        }

        const task = lib.getDocument({ url: src });
        signal.addEventListener(
          "abort",
          () => {
            task.destroy();
          },
          { once: true }
        );

        const doc = await task.promise;
        const sizes: { number: number; width: number; height: number }[] = [];

        for (let i = 1; i <= doc.numPages; i += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- pages are read and drawn in order, one at a time, so a large PDF does not hold every page in memory
          const pdfPage = await doc.getPage(i);
          const viewport = pdfPage.getViewport({ scale: 1 });
          sizes.push({
            number: i,
            width: viewport.width,
            height: viewport.height,
          });
        }

        if (signal.aborted) {
          return;
        }

        setPages(sizes);
        onPagesRef.current?.(sizes.length);
        // Drawn once the canvases exist, one page after the other.
        await nextFrame();

        for (let i = 1; i <= doc.numPages; i += 1) {
          if (signal.aborted) {
            break;
          }

          // oxlint-disable-next-line eslint/no-await-in-loop -- pages are read and drawn in order, one at a time, so a large PDF does not hold every page in memory
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });

          const viewport = page.getViewport({
            scale: RENDER_WIDTH / base.width,
          });

          const canvas = canvases.current[i - 1];

          if (!canvas) {
            continue;
          }

          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          // oxlint-disable-next-line eslint/no-await-in-loop -- pages are read and drawn in order, one at a time, so a large PDF does not hold every page in memory
          await page.render({ canvas, viewport }).promise;
        }
      } catch {
        if (!signal.aborted) {
          setFailed(true);
        }
      }
    })();

    return () => drawing.abort();
  }, [src]);

  return (
    <div ref={column} className="mx-auto w-full max-w-[880px] space-y-4">
      {failed && (
        <Notice tone="error">
          The PDF could not be shown. Reload the page to try again.
        </Notice>
      )}
      {!pages && !failed && (
        <div className="text-muted flex h-64 items-center justify-center">
          <Loader2
            className="h-5 w-5 animate-spin"
            aria-label="Loading the PDF"
          />
        </div>
      )}
      {pages?.map((size, i) => (
        <div
          key={size.number}
          className="relative w-full overflow-hidden rounded-sm bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_2px_8px_rgb(0_0_0/0.12)]"
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
          aria-label={`Page ${i + 1} of ${pages.length}`}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a page of the PDF is a labelled group; none of the elements the rule names (address, details, fieldset) holds a drawn page
          role="group"
        >
          <canvas
            ref={(el) => {
              canvases.current[i] = el;
            }}
            className="absolute inset-0 h-full w-full"
          />
          {renderOverlay && width > 0 && (
            <div className="absolute inset-0">
              {renderOverlay(i, {
                width: size.width,
                height: size.height,
                scale: width / size.width,
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
