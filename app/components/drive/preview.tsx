import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { TEXT_PREVIEW_BYTES, formatSize, previewOf } from "~/lib/drive/drive";

import { KindIcon } from "./icons";

const NoPreview = ({
  download,
  name,
  contentType,
  why,
}: {
  download: string | null;
  name: string;
  contentType: string;
  why: string;
}) => (
  <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
    <KindIcon
      kind="file"
      name={name}
      contentType={contentType}
      className="h-12 w-12"
    />
    <p className="text-muted text-base">{why}</p>
    {download ? (
      <a
        href={download}
        className="bg-accent text-accent-fg hover:bg-accent-hover inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-base font-medium"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </a>
    ) : (
      <p className="text-subtle text-sm">Downloads are off for this link.</p>
    )}
  </div>
);

/** A text file's content, fetched when it shows; the caller keys it by `src`, so another file starts it over. */
const TextPreview = ({
  src,
  download,
  name,
  contentType,
}: {
  src: string;
  download: string | null;
  name: string;
  contentType: string;
}) => {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(src)
      .then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(String(r.status)))
      )
      .then((t) => live && setText(t))
      .catch(() => live && setFailed(true));

    return () => {
      live = false;
    };
  }, [src]);

  if (failed) {
    return (
      <NoPreview
        download={download}
        name={name}
        contentType={contentType}
        why="The file could not be read."
      />
    );
  }

  return (
    <pre className="text-fg max-h-[76vh] overflow-auto p-4 font-mono text-sm leading-5 break-words whitespace-pre-wrap">
      {text ?? ""}
    </pre>
  );
};

/**
 * The file itself, where the browser can show it: an image, audio, video, a PDF (framed) or text. `src` is its file
 * route (the session's, or a link's), `download` the address that downloads it, null where it may not be downloaded.
 */
export const FilePreview = ({
  src,
  download,
  name,
  contentType,
  size,
}: {
  src: string;
  download: string | null;
  name: string;
  contentType: string;
  size: number;
}) => {
  const kind = previewOf(contentType, name);
  const textual = kind === "text" || kind === "code";

  if (kind === "image") {
    return (
      <div className="flex items-center justify-center p-4">
        <img
          src={src}
          alt={name}
          className="max-h-[72vh] max-w-full rounded-md object-contain"
        />
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <KindIcon
          kind="file"
          name={name}
          contentType={contentType}
          className="h-12 w-12"
        />
        <audio
          controls
          src={src}
          preload="metadata"
          className="w-full max-w-lg"
        />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="flex items-center justify-center bg-black/90 p-2">
        <video
          controls
          src={src}
          preload="metadata"
          className="max-h-[72vh] max-w-full"
        />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      // oxlint-disable-next-line react/iframe-missing-sandbox -- the browser shows no PDF in a sandboxed frame (its viewer is a plugin); the file is served same-origin with `frame-ancestors 'self'` and no script of the page reaches it
      <iframe title={name} src={src} className="h-[76vh] w-full bg-white" />
    );
  }

  if (textual) {
    if (size > TEXT_PREVIEW_BYTES) {
      return (
        <NoPreview
          download={download}
          name={name}
          contentType={contentType}
          why="This text file is too large to show here."
        />
      );
    }

    return (
      <TextPreview
        key={src}
        src={src}
        download={download}
        name={name}
        contentType={contentType}
      />
    );
  }

  return (
    <NoPreview
      download={download}
      name={name}
      contentType={contentType}
      why={`No preview for this ${formatSize(size)} file.`}
    />
  );
};
