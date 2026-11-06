import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
} from "lucide-react";

import { fileKind } from "~/lib/drive/drive";
import type { FileKind } from "~/lib/drive/drive";

import { cx } from "../ui";

const ICONS: Record<FileKind, React.ComponentType<{ className?: string }>> = {
  folder: Folder,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  pdf: FileText,
  text: FileText,
  code: FileCode,
  archive: FileArchive,
  document: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  file: File,
};

/** A hue per kind from the label palette, so a listing reads at a glance; folders and plain files stay quiet. */
const TONES: Record<FileKind, string> = {
  folder: "text-muted",
  image: "text-(--label-violet)",
  audio: "text-(--label-pink)",
  video: "text-(--label-orange)",
  pdf: "text-red",
  text: "text-subtle",
  code: "text-(--label-teal)",
  archive: "text-subtle",
  document: "text-(--label-blue)",
  sheet: "text-accent",
  slides: "text-amber",
  file: "text-subtle",
};

export const KIND_LABEL: Record<FileKind, string> = {
  folder: "Folder",
  image: "Image",
  audio: "Audio",
  video: "Video",
  pdf: "PDF",
  text: "Text",
  code: "Code",
  archive: "Archive",
  document: "Document",
  sheet: "Spreadsheet",
  slides: "Presentation",
  file: "File",
};

export const KindIcon = ({
  kind,
  name,
  contentType,
  className,
}: {
  kind: "folder" | "file";
  name: string;
  contentType: string;
  className?: string;
}) => {
  const k = fileKind(contentType, name, kind);
  const Icon = ICONS[k];

  return <Icon className={cx("shrink-0", TONES[k], className)} aria-hidden />;
};
