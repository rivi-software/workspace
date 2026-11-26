import {
  MAX_DOCUMENT_BYTES,
  documentsFor,
  isDocument,
} from "~/lib/documents.server";
import { fileKind } from "~/lib/drive/drive";

/**
 * A file's contents as the assistant reads them, whether the file sits in Drive or on a message: a text
 * file as it is, a PDF or an office document through the document conversion, anything else not at all. The caller
 * passed its own gate first and hands over what the file is and how to load its bytes.
 */

/** A text file is read whole up to this size. */
const MAX_TEXT_BYTES = 256 * 1024;

/** What the model gets of a file's text, at most. */
export const MAX_FILE_CHARS = 80_000;

export type FileText = { text: string; truncated: boolean } | { error: string };

/** Whether a file's contents read as text: what the file page shows as text or code, and the structured formats. */
const readsAsText = (contentType: string, name: string): boolean => {
  const kind = fileKind(contentType, name, "file");

  if (kind === "text" || kind === "code") {
    return true;
  }

  return /^(?:text\/|application\/(?:json|xml|yaml|x-yaml|csv|sql|javascript|typescript|x-sh))/iu.test(
    contentType
  );
};

/** A size limit in words: "256 KB", "4 MB". */
const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;

const cut = (text: string): FileText => ({
  text: text.slice(0, MAX_FILE_CHARS),
  truncated: text.length > MAX_FILE_CHARS,
});

/** The text of a file, or why it has none the assistant can read. */
export const fileText = async (
  env: Env,
  file: { name: string; contentType: string; size: number },
  load: () => Promise<ArrayBuffer | null>
): Promise<FileText> => {
  const document = isDocument(file.contentType, file.name);

  // A CSV is both: it reads as text, which needs no conversion.
  if (!document && !readsAsText(file.contentType, file.name)) {
    return {
      error: `“${file.name}” is ${file.contentType}, which cannot be read as text.`,
    };
  }

  const text = readsAsText(file.contentType, file.name);
  const limit = text ? MAX_TEXT_BYTES : MAX_DOCUMENT_BYTES;

  if (file.size > limit) {
    return {
      error: `“${file.name}” is too large to read: more than ${sizeLabel(limit)}.`,
    };
  }

  const documents = text ? null : documentsFor(env);

  if (!text && !documents) {
    return { error: "No document reader is set up to read this kind of file." };
  }

  const bytes = await load();

  if (!bytes) {
    return { error: "The file's contents are missing." };
  }

  if (!documents) {
    return cut(new TextDecoder().decode(bytes));
  }

  const read = await documents.read({
    name: file.name,
    contentType: file.contentType,
    bytes,
  });

  if (!read.ok) {
    return {
      error: `“${file.name}” could not be read: ${read.error}`,
    };
  }

  return read.text.trim()
    ? cut(read.text)
    : {
        error: `“${file.name}” holds no text to read: it may be a scan or pictures only.`,
      };
};
