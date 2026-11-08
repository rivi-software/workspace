import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
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

import { driveFolderPath } from "~/lib/drive/actions";
import {
  SIMPLE_UPLOAD_LIMIT,
  UPLOAD_PART_SIZE,
  formatSize,
} from "~/lib/drive/drive";
import {
  defined,
  errorMessage,
  isJsonObject,
  stringOrNull,
} from "~/lib/guards";

import { IconButton, cx } from "../ui";
import { KindIcon } from "./icons";

export type UploadStatus =
  | "waiting"
  | "uploading"
  | "done"
  | "failed"
  | "cancelled";

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  type: string;
  sent: number;
  status: UploadStatus;
  error: string | null;
  /** The folder it goes into, and the folders of a whole-folder upload still to be made under it. */
  folderId: string | null;
  relativeDir: string;
  nodeId: string | null;
}

interface UploadsApi {
  items: UploadItem[];
  /** How many are still on their way. */
  active: number;
  /** Queue files for a folder (the person's root when null); a file with a relative path lands in that folder below it. */
  add: (files: File[], folderId: string | null) => void;
  cancel: (id: number) => void;
  /** Forget the uploads that ended. */
  clear: () => void;
}

const UploadsContext = createContext<UploadsApi | null>(null);

const CONCURRENCY = 3;

class CancelledError extends Error {
  override name = "CancelledError";
}

interface Control {
  cancelled: boolean;
  xhr: XMLHttpRequest | null;
  nodeId: string | null;
}

interface UploadedPart {
  partNumber: number;
  etag: string;
}

type UploadAnswer =
  | {
      ok: true;
      node?: { id: string };
      part?: UploadedPart;
    }
  | { ok: false; error: string };

/** A PUT with progress: `fetch` cannot report how much of a body went, so uploads go through XMLHttpRequest. */
const put = (
  url: string,
  body: Blob,
  contentType: string,
  control: Control,
  onProgress: (sent: number) => void
): Promise<UploadAnswer> =>
  // oxlint-disable-next-line promise/avoid-new -- XMLHttpRequest reports through events, so only a Promise executor can turn its end into a promise
  new Promise((resolve, reject) => {
    if (control.cancelled) {
      reject(new CancelledError());

      return;
    }

    const xhr = new XMLHttpRequest();
    control.xhr = xhr;
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (e) => onProgress(e.loaded));
    xhr.addEventListener("load", () => {
      control.xhr = null;
      // SAFETY: the upload route answers every PUT with an UploadAnswer as JSON; a body that is not JSON reads as null with responseType "json".
      const answer = xhr.response as UploadAnswer | null;

      if (xhr.status >= 200 && xhr.status < 300 && answer?.ok) {
        resolve(answer);
      } else {
        reject(
          new Error(
            answer && !answer.ok
              ? answer.error
              : `The upload failed (${xhr.status}).`
          )
        );
      }
    });

    xhr.addEventListener("error", () => {
      control.xhr = null;
      reject(new Error("The connection dropped."));
    });

    xhr.addEventListener("abort", () => {
      control.xhr = null;
      reject(new CancelledError());
    });

    xhr.send(body);
  });

type UploadRequest =
  | {
      intent: "start";
      folder: string;
      name: string;
      size: number;
      type: string;
    }
  | { intent: "finish"; id: string; parts: UploadedPart[] }
  | { intent: "abort"; id: string };

/** What `start` is answered with: the row the parts belong to and how large each part is. `finish` and `abort` answers are not read. */
interface StartedUpload {
  id: string;
  partSize: number;
}

const post = async (body: UploadRequest): Promise<StartedUpload> => {
  const res = await fetch("/api/drive/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data: unknown = await res.json().catch(() => null);
  const answer = isJsonObject(data) ? data : null;

  if (!res.ok || !answer?.ok) {
    throw new Error(
      stringOrNull(answer?.error) ?? `The upload failed (${res.status}).`
    );
  }

  return {
    id: String(answer.id),
    partSize: Number(answer.partSize) || UPLOAD_PART_SIZE,
  };
};

const contentTypeOf = (file: File) => file.type || "application/octet-stream";

/** A file up to the simple limit goes whole, in one request. */
const uploadWhole = async (
  file: File,
  folderId: string | null,
  control: Control,
  onSent: (sent: number) => void
) => {
  const params = new URLSearchParams({ name: file.name });

  if (folderId) {
    params.set("folder", folderId);
  }

  const answer = await put(
    `/api/drive/upload?${params}`,
    file,
    contentTypeOf(file),
    control,
    onSent
  );

  control.nodeId = answer.ok && answer.node ? answer.node.id : null;
};

/** A larger file goes in parts, one after another and in order (R2 multipart), then is joined. */
const uploadInParts = async (
  file: File,
  folderId: string | null,
  control: Control,
  onSent: (sent: number) => void
) => {
  const { id, partSize } = await post({
    intent: "start",
    folder: folderId ?? "",
    name: file.name,
    size: file.size,
    type: contentTypeOf(file),
  });

  control.nodeId = id;
  const parts: UploadedPart[] = [];

  for (let n = 1, offset = 0; offset < file.size; n += 1, offset += partSize) {
    if (control.cancelled) {
      throw new CancelledError();
    }

    const chunk = file.slice(offset, Math.min(file.size, offset + partSize));

    // oxlint-disable-next-line eslint/no-await-in-loop -- a file's parts upload one after another, in order
    const answer = await put(
      `/api/drive/upload?id=${encodeURIComponent(id)}&part=${n}`,
      chunk,
      "application/octet-stream",
      control,
      (sent) => onSent(offset + sent)
    );

    if (!answer.ok || !answer.part) {
      throw new Error("The part was not taken.");
    }

    parts.push(answer.part);
  }

  await post({ intent: "finish", id, parts });
};

interface UploadSteps {
  folderFor: (base: string | null, dir: string) => Promise<string | null>;
  patch: (id: number, change: Partial<UploadItem>) => void;
  invalidateSoon: () => void;
}

/** One upload from its folder to its end: what happened goes onto its item, and `onEnd` runs after, whatever happened. */
const transfer = async (
  item: UploadItem,
  file: File,
  control: Control,
  { folderFor, patch, invalidateSoon }: UploadSteps,
  onEnd: () => void
) => {
  try {
    const folderId = await folderFor(item.folderId, item.relativeDir);

    if (control.cancelled) {
      throw new CancelledError();
    }

    const upload =
      file.size <= SIMPLE_UPLOAD_LIMIT ? uploadWhole : uploadInParts;

    await upload(file, folderId, control, (sent) => patch(item.id, { sent }));

    patch(item.id, { status: "done", sent: file.size, nodeId: control.nodeId });
    invalidateSoon();
  } catch (error) {
    if (error instanceof CancelledError || control.cancelled) {
      patch(item.id, { status: "cancelled" });

      if (control.nodeId && file.size > SIMPLE_UPLOAD_LIMIT) {
        post({ intent: "abort", id: control.nodeId }).catch(() => null);
      }
    } else {
      patch(item.id, { status: "failed", error: errorMessage(error) });
    }
  } finally {
    onEnd();
  }
};

/**
 * The uploads of the session, from any Drive page: a file at a time goes whole in one request, or in parts when it
 * is large (R2 multipart), three at once; what finished refreshes the page. The panel at the bottom shows them.
 */
export const UploadProvider = ({ children }: { children: ReactNode }) => {
  const router = useRouter();
  const folderPath = useServerFn(driveFolderPath);
  const [items, setItems] = useState<UploadItem[]>([]);
  const files = useRef(new Map<number, File>());
  const controls = useRef(new Map<number, Control>());
  const queue = useRef<number[]>([]);
  const running = useRef(0);
  const pumpRef = useRef<(() => void) | null>(null);
  const next = useRef(1);
  const refresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The folders a whole-folder upload makes, once each: "<base folder>|<relative dir>" to the folder's id.
  const dirs = useRef(new Map<string, Promise<string | null>>());

  const patch = useCallback((id: number, change: Partial<UploadItem>) => {
    setItems((list) =>
      list.map((u) => (u.id === id ? { ...u, ...change } : u))
    );
  }, []);

  const invalidateSoon = useCallback(() => {
    if (refresh.current) {
      clearTimeout(refresh.current);
    }

    refresh.current = setTimeout(() => {
      void router.invalidate();
    }, 300);
  }, [router]);

  const folderFor = useCallback(
    (base: string | null, dir: string): Promise<string | null> => {
      if (!dir) {
        return Promise.resolve(base);
      }

      const key = `${base ?? ""}|${dir}`;
      let pending = dirs.current.get(key);

      if (!pending) {
        pending = folderPath({
          data: { parent: base, segments: dir.split("/") },
        }).then((r) => {
          if (!r.ok) {
            throw new Error(r.error);
          }

          return r.folderId;
        });
        dirs.current.set(key, pending);
      }

      return pending;
    },
    [folderPath]
  );

  const run = useCallback(
    async (item: UploadItem) => {
      const file = files.current.get(item.id);
      const control = controls.current.get(item.id);

      if (!file || !control) {
        return;
      }

      patch(item.id, { status: "uploading" });

      await transfer(
        item,
        file,
        control,
        { folderFor, patch, invalidateSoon },
        () => {
          files.current.delete(item.id);
          running.current -= 1;
          pumpRef.current?.();
        }
      );
    },
    [patch, folderFor, invalidateSoon]
  );

  const pump = useCallback(() => {
    setItems((list) => {
      while (running.current < CONCURRENCY && queue.current.length) {
        const id = defined(queue.current.shift(), "the result of shift");
        const item = list.find((u) => u.id === id);
        const control = controls.current.get(id);

        if (!item || !control || control.cancelled) {
          continue;
        }

        running.current += 1;
        void run(item);
      }

      return list;
    });
  }, [run]);

  // `run` hands the queue on when it ends, and `pump` starts `run`: the latest `pump` is kept for it in a ref.
  useEffect(() => {
    pumpRef.current = pump;
  });

  const add = useCallback(
    (chosen: File[], folderId: string | null) => {
      const fresh: UploadItem[] = [];

      for (const file of chosen) {
        const id = next.current;
        next.current += 1;

        const relative = file.webkitRelativePath ?? "";

        const relativeDir = relative.includes("/")
          ? relative.slice(0, relative.lastIndexOf("/"))
          : "";

        files.current.set(id, file);
        controls.current.set(id, { cancelled: false, xhr: null, nodeId: null });
        queue.current.push(id);
        fresh.push({
          id,
          name: file.name,
          size: file.size,
          type: file.type,
          sent: 0,
          status: "waiting",
          error: null,
          folderId,
          relativeDir,
          nodeId: null,
        });
      }

      if (!fresh.length) {
        return;
      }

      setItems((list) => [...list, ...fresh]);
      // The items are in state before the queue is pumped, so `run` finds them.
      setTimeout(pump, 0);
    },
    [pump]
  );

  const cancel = useCallback((id: number) => {
    const control = controls.current.get(id);

    if (!control) {
      return;
    }

    control.cancelled = true;
    control.xhr?.abort();
    queue.current = queue.current.filter((x) => x !== id);
    setItems((list) =>
      list.map((u) =>
        u.id === id && u.status === "waiting"
          ? { ...u, status: "cancelled" }
          : u
      )
    );
    files.current.delete(id);
  }, []);

  const clear = useCallback(() => {
    setItems((list) => {
      const keep = list.filter(
        (u) => u.status === "waiting" || u.status === "uploading"
      );

      for (const u of list) {
        if (!keep.includes(u)) {
          controls.current.delete(u.id);
        }
      }

      return keep;
    });
  }, []);

  const active = items.filter(
    (u) => u.status === "waiting" || u.status === "uploading"
  ).length;

  // Leaving the page would lose what is still on its way.
  useEffect(() => {
    if (!active) {
      return;
    }

    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const api = useMemo<UploadsApi>(
    () => ({ items, active, add, cancel, clear }),
    [items, active, add, cancel, clear]
  );

  return (
    <UploadsContext.Provider value={api}>{children}</UploadsContext.Provider>
  );
};

export const useUploads = (): UploadsApi => {
  const api = useContext(UploadsContext);

  if (!api) {
    throw new Error("useUploads needs an UploadProvider");
  }

  return api;
};

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const panelTitle = (active: number, failed: number, done: number) => {
  if (active) {
    return `Uploading ${count(active, "file", "files")}`;
  }

  if (failed) {
    return `${count(failed, "upload", "uploads")} failed`;
  }

  return `${count(done, "upload", "uploads")} done`;
};

/** What ends an upload's row: a tick when it is done, a cancel while it runs, else a spacer. */
const UploadEnd = ({
  upload,
  onCancel,
}: {
  upload: UploadItem;
  onCancel: () => void;
}) => {
  if (upload.status === "done") {
    return (
      <Check className="text-accent h-3.5 w-3.5 shrink-0" aria-label="Done" />
    );
  }

  if (upload.status === "waiting" || upload.status === "uploading") {
    return (
      <IconButton size="sm" label={`Cancel ${upload.name}`} onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </IconButton>
    );
  }

  return (
    <span
      className={cx(
        "w-6",
        upload.status === "failed" ? "text-red" : "text-subtle"
      )}
    />
  );
};

/** The uploads of the session, bottom right: each with its progress, a cancel while it runs, and what went wrong. */
export const UploadPanel = () => {
  const { items, active, cancel, clear } = useUploads();
  const [folded, setFolded] = useState(false);

  if (!items.length) {
    return null;
  }

  const done = items.filter((u) => u.status === "done").length;
  const failed = items.filter((u) => u.status === "failed").length;

  const title = panelTitle(active, failed, done);

  return (
    <section
      aria-label="Uploads"
      className="border-line bg-elevated shadow-dialog animate-rise-in print-hidden bottom-dock fixed right-4 z-50 w-[min(92vw,360px)] overflow-hidden rounded-lg border"
    >
      <div className="border-line bg-sidebar flex h-9 items-center gap-1 border-b px-3 text-base font-medium">
        {active > 0 && (
          <Loader2 className="text-accent h-3.5 w-3.5 animate-spin" />
        )}
        <span className="flex-1 truncate">{title}</span>
        <IconButton
          size="sm"
          label={folded ? "Show uploads" : "Hide uploads"}
          onClick={() => setFolded((f) => !f)}
        >
          {folded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </IconButton>
        {!active && (
          <IconButton size="sm" label="Close" onClick={clear}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {!folded && (
        <ul className="max-h-64 overflow-y-auto py-1">
          {items.map((u) => (
            <li
              key={u.id}
              className="flex items-center gap-2 px-3 py-1.5 text-sm"
            >
              <KindIcon
                kind="file"
                name={u.name}
                contentType={u.type}
                className="h-4 w-4"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-fg truncate">{u.name}</span>
                  <span className="tnum text-subtle ml-auto shrink-0">
                    {u.status === "uploading"
                      ? `${Math.min(99, Math.floor((u.sent / Math.max(1, u.size)) * 100))}%`
                      : formatSize(u.size)}
                  </span>
                </div>
                {u.status === "uploading" && (
                  <div
                    className="bg-hover mt-1 h-1 overflow-hidden rounded-full"
                    aria-hidden
                  >
                    <div
                      className="bg-accent h-full rounded-full transition-[width] duration-200"
                      style={{
                        width: `${Math.min(100, (u.sent / Math.max(1, u.size)) * 100)}%`,
                      }}
                    />
                  </div>
                )}
                {u.status === "failed" && (
                  <div className="text-red truncate text-xs">{u.error}</div>
                )}
                {u.status === "cancelled" && (
                  <div className="text-subtle text-xs">Cancelled</div>
                )}
                {u.status === "waiting" && (
                  <div className="text-subtle text-xs">Waiting</div>
                )}
              </div>
              <UploadEnd upload={u} onCancel={() => cancel(u.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
