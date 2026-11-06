import { defined } from "~/lib/guards";
/**
 * Drive's shared vocabulary: the views, the sort orders, the file kinds, the names and the limits the sidebar, the
 * list, the uploader and the server (`drive.server.ts`) agree on. A plain module: route components read it.
 */

export const DRIVE_VIEWS = [
  "mine",
  "shared",
  "recent",
  "starred",
  "trash",
] as const;

export type DriveView = (typeof DRIVE_VIEWS)[number];

export const isDriveView = (value: string | undefined): value is DriveView =>
  DRIVE_VIEWS.some((view) => view === value);

/** A node's page: a folder's listing or a file's preview. */
export const nodeHref = (node: {
  id: string;
  kind: "folder" | "file";
}): string =>
  node.kind === "folder" ? `/drive/f/${node.id}` : `/drive/d/${node.id}`;

/**
 * A page of what a link shares outside the workspace: the node it shares, or `nodeId` under it. The token is the
 * path's one secret (`SECRET_PATHS` in `app/lib/posthog-config.ts`); everything public lives under `/s/`.
 */
export const sharedHref = (token: string, nodeId?: string | null): string =>
  nodeId ? `/s/${token}?n=${encodeURIComponent(nodeId)}` : `/s/${token}`;

/** A file's bytes through a link: the public counterpart of `/api/drive/files/$id`. */
export const sharedFileHref = (
  token: string,
  nodeId: string,
  download = false
): string => `/s/${token}/file/${nodeId}${download ? "?download=1" : ""}`;

/** Whether a path is one of a link's public pages or files, where nobody is signed in. */
export const isSharedPath = (pathname: string): boolean =>
  pathname.startsWith("/s/");

/** A search over the names the person may see, or a view when `q` is empty. */
export const driveHref = (q = "", view: DriveView = "mine"): string => {
  if (q) {
    return `/drive?q=${encodeURIComponent(q)}`;
  }

  return view === "mine" ? "/drive" : `/drive?view=${view}`;
};

export const DRIVE_VIEW_LABEL: Record<DriveView, string> = {
  mine: "My Drive",
  shared: "Shared with me",
  recent: "Recent",
  starred: "Starred",
  trash: "Trash",
};

export const DRIVE_SORTS = ["name", "updated", "size"] as const;

export type DriveSort = (typeof DRIVE_SORTS)[number];

export type DriveDir = "asc" | "desc";

export const isDriveSort = (value: string | undefined): value is DriveSort =>
  DRIVE_SORTS.some((option) => option === value);

export const DRIVE_SORT_LABEL: Record<DriveSort, string> = {
  name: "Name",
  updated: "Last modified",
  size: "Size",
};

/** What a person may do with a node: their own, or shared with them to edit or to read. */
export type DriveRole = "owner" | "editor" | "viewer";

export const DRIVE_SHARE_ROLES = ["viewer", "editor"] as const;

export type DriveShareRole = (typeof DRIVE_SHARE_ROLES)[number];

/** Whether a role lets the person add, rename, move and trash: the owner's, or an editor's share. */
export const canEdit = (role: DriveRole | null | undefined): boolean =>
  role === "owner" || role === "editor";

export const isShareRole = (
  value: string | undefined
): value is DriveShareRole => DRIVE_SHARE_ROLES.some((role) => role === value);

export const DRIVE_ROLE_LABEL: Record<DriveShareRole, string> = {
  viewer: "Can view",
  editor: "Can edit",
};

/** The subject of a share with everyone in the workspace, next to a person's id. */
export const EVERYONE = "everyone";

export const MAX_NODE_NAME = 255;

/** Folders nest this deep at most: a path of ids stays one short text column, and a breadcrumb stays readable. */
export const MAX_DEPTH = 32;

/** The trash lets go of what has been in it this long. */
export const DRIVE_EXPIRY_DAYS = 30;

/** A link or invite outside the workspace ends this long after it was made, unless its creator chose otherwise. */
export const LINK_DEFAULT_DAYS = 30;

/** A link's password is at least this long. */
export const LINK_PASSWORD_MIN = 6;

/** An upload that never finished is abandoned after this long: its parts are dropped and its row removed. */
export const UPLOAD_ABANDON_HOURS = 24;

/** A file up to this size is sent whole in one request; a larger one goes in parts (R2 multipart). */
export const SIMPLE_UPLOAD_LIMIT = 32 * 1024 * 1024;

/** The size of a part: R2 wants every part but the last at least 5 MiB and all parts the same size. */
export const UPLOAD_PART_SIZE = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/** At most this many rows in a listing, a search or a view. */
export const LIST_LIMIT = 1000;

/** What a row of a listing carries to the client. */
export interface DriveRow {
  id: string;
  kind: "folder" | "file";
  name: string;
  contentType: string;
  size: number;
  updatedAt: string;
  createdAt: string;
  trashedAt: string | null;
  /** Whether the reader starred it. */
  starred: boolean;
  /** Whether its owner shared it with anyone (a marker on the owner's own rows). */
  shared: boolean;
  /** Whether a live link or invite shares it outside the workspace (a marker on everyone's rows). */
  linked: boolean;
  role: DriveRole;
  owner: { id: string; name: string };
  /** The folder it sits in, for a row shown outside its folder (a search, Recent, Starred). */
  parentId: string | null;
}

export interface DriveCrumb {
  id: string;
  name: string;
}

/** A row of a folder shared outside the workspace, as its public page lists it: no owner, no star, no role. */
export type SharedRow = Pick<
  DriveRow,
  "id" | "kind" | "name" | "contentType" | "size" | "updatedAt"
>;

/** "j•••@acme.com": an invitee's address as the page a link opens shows it, before anyone confirmed. */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf("@");

  if (at < 1) {
    return "•••";
  }

  return `${email[0]}•••${email.slice(at)}`;
};

/** The kinds the list draws an icon for and the file page knows how to show. */
export type FileKind =
  | "folder"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "text"
  | "code"
  | "archive"
  | "document"
  | "sheet"
  | "slides"
  | "file";

const EXT_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["svg", "image/svg+xml"],
  ["bmp", "image/bmp"],
  ["heic", "image/heic"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["ogg", "audio/ogg"],
  ["opus", "audio/opus"],
  ["aiff", "audio/aiff"],
  ["aif", "audio/aiff"],
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["mkv", "video/x-matroska"],
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["csv", "text/csv"],
  ["log", "text/plain"],
  ["json", "application/json"],
  ["xml", "application/xml"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["css", "text/css"],
  ["js", "text/javascript"],
  ["mjs", "text/javascript"],
  ["ts", "text/typescript"],
  ["tsx", "text/typescript"],
  ["jsx", "text/javascript"],
  ["py", "text/x-python"],
  ["sh", "text/x-shellscript"],
  ["sql", "application/sql"],
  ["zip", "application/zip"],
  ["gz", "application/gzip"],
  ["tar", "application/x-tar"],
  ["7z", "application/x-7z-compressed"],
  ["rar", "application/vnd.rar"],
  ["doc", "application/msword"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["odt", "application/vnd.oasis.opendocument.text"],
  ["rtf", "application/rtf"],
  ["pages", "application/vnd.apple.pages"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ["numbers", "application/vnd.apple.numbers"],
  ["ppt", "application/vnd.ms-powerpoint"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["odp", "application/vnd.oasis.opendocument.presentation"],
  ["key", "application/vnd.apple.keynote"],
]);

/** -1, 0 or 1 as `a` sorts before, with or after `b` by code unit (ISO timestamps sort this way). */
const compareText = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

export const extensionOf = (name: string): string => {
  const i = name.lastIndexOf(".");

  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
};

/** The media type of a file: what the browser said, else what its extension says, else bytes. */
export const contentTypeFor = (name: string, given?: string | null): string => {
  const g = defined((given ?? "").split(";")[0], "the first item")
    .trim()
    .toLowerCase();

  if (g && g !== "application/octet-stream") {
    return g;
  }

  return EXT_TYPES.get(extensionOf(name)) ?? "application/octet-stream";
};

export const fileKind = (
  contentType: string,
  name: string,
  kind: "folder" | "file"
): FileKind => {
  if (kind === "folder") {
    return "folder";
  }

  const type = contentType.toLowerCase();
  const ext = extensionOf(name);

  if (type.startsWith("image/")) {
    return "image";
  }

  if (type.startsWith("audio/")) {
    return "audio";
  }

  if (type.startsWith("video/")) {
    return "video";
  }

  if (type === "application/pdf") {
    return "pdf";
  }

  if (
    /^(?:application\/(?:zip|gzip|x-tar|x-7z-compressed|vnd\.rar|x-bzip2))$/u.test(
      type
    ) ||
    ["zip", "gz", "tgz", "tar", "7z", "rar", "bz2"].includes(ext)
  ) {
    return "archive";
  }

  if (
    /wordprocessingml|msword|opendocument\.text|apple\.pages|rtf/u.test(type)
  ) {
    return "document";
  }

  if (
    /spreadsheetml|ms-excel|opendocument\.spreadsheet|apple\.numbers/u.test(
      type
    ) ||
    type === "text/csv"
  ) {
    return "sheet";
  }

  if (
    /presentationml|ms-powerpoint|opendocument\.presentation|apple\.keynote/u.test(
      type
    )
  ) {
    return "slides";
  }

  if (
    /^(?:text\/(?:javascript|typescript|css|html|x-python|x-shellscript))$|^application\/(?:json|xml|yaml|sql|javascript)$/u.test(
      type
    ) ||
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "sh",
      "sql",
      "json",
      "xml",
      "yaml",
      "yml",
      "css",
      "html",
    ].includes(ext)
  ) {
    return "code";
  }

  if (type.startsWith("text/")) {
    return "text";
  }

  return "file";
};

/** Whether the file page can show the file itself, and how. */
export const previewOf = (
  contentType: string,
  name: string
): FileKind | null => {
  const kind = fileKind(contentType, name, "file");

  if (kind === "image" && contentType.toLowerCase() === "image/svg+xml") {
    return null;
  }

  if (
    kind === "image" ||
    kind === "audio" ||
    kind === "video" ||
    kind === "pdf"
  ) {
    return kind;
  }

  if (kind === "text" || kind === "code") {
    return kind;
  }

  return null;
};

/** The most text the file page reads of a text file. */
export const TEXT_PREVIEW_BYTES = 512 * 1024;

/**
 * A name as it may be kept: trimmed, without a slash or a control character, at most `MAX_NODE_NAME` characters,
 * and not one of the names a file system reserves for its own use. Empty when nothing usable is left.
 */
export const cleanName = (raw: string): string => {
  const name = raw
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what a name must not carry
    .replaceAll(/[\u0000-\u001F\u007F/\\]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_NODE_NAME)
    .trim();

  if (name === "." || name === "..") {
    return "";
  }

  return name;
};

/** "report.pdf" → ["report", ".pdf"]; "notes" → ["notes", ""]; ".env" → [".env", ""]. */
export const splitExtension = (name: string): [string, string] => {
  const i = name.lastIndexOf(".");

  if (i <= 0) {
    return [name, ""];
  }

  return [name.slice(0, i), name.slice(i)];
};

/** The name itself when free, else "name (2)", "name (3)"… before the extension; `taken` holds the lowercased names in use. */
export const nextName = (name: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(name.toLowerCase())) {
    return name;
  }

  const [base, ext] = splitExtension(name);
  const stem = base.replace(/ \((?:\d+)\)$/u, "");

  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;

    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${stem} (${Date.now()})${ext}`;
};

/** Bytes as people read them: "12 KB", "3.4 MB", "1.2 GB". */
export const formatSize = (n: number): string => {
  if (n < 1024) {
    return `${n} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;

  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }

  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

/** The ids of a node's ancestors, root first, from its materialized path ("/a/b/" → ["a", "b"]). */
export const ancestorIds = (path: string): string[] =>
  path.split("/").filter(Boolean);

/** The prefix every descendant's path starts with: the node's own path with its id on the end. */
export const subtreePrefix = (node: { path: string; id: string }): string =>
  `${node.path}${node.id}/`;

/** The ordering of a listing: folders before files, then the chosen column. */
export const compareRows = (sort: DriveSort, dir: DriveDir) => {
  const sign = dir === "desc" ? -1 : 1;

  type Sortable = Pick<DriveRow, "kind" | "name" | "size" | "updatedAt">;

  return (a: Sortable, b: Sortable): number => {
    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }

    let d = 0;

    if (sort === "updated") {
      d = compareText(a.updatedAt, b.updatedAt);
    } else if (sort === "size") {
      d = a.size - b.size;
    }

    if (d === 0) {
      d = a.name.localeCompare(b.name, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    }

    return d * sign;
  };
};

/** The content types the file route serves inline (a browser tab, a preview); the rest download. */
export const servesInline = (contentType: string): boolean => {
  const type = contentType.toLowerCase();

  return (
    /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/u.test(type) ||
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    type === "application/pdf" ||
    type === "text/plain" ||
    type === "text/markdown" ||
    type === "text/csv" ||
    type === "application/json"
  );
};
