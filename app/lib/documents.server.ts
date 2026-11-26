/**
 * The text of a document that is no text file: a PDF, a Word or OpenDocument text, a spreadsheet. Workers AI
 * converts it to Markdown (`env.AI.toMarkdown`) on Cloudflare's own hardware, which keeps nothing once it has
 * answered. Images inside a document are left out: describing one is a call of a vision model of its own.
 */

/** What reads a document's text: Workers AI in the Worker, a stand-in a test lays over `env`. */
export interface DocumentReader {
  read: (file: {
    name: string;
    contentType: string;
    bytes: ArrayBuffer;
  }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

/** The largest document handed to the conversion: Cloudflare's own limit for a PDF without OCR and the office formats. */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** The file name extensions the conversion reads (Workers AI's supported formats, the images and the text files aside). */
const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "xlsx",
  "xlsm",
  "xlsb",
  "xls",
  "odt",
  "ods",
  "numbers",
]);

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.apple.numbers",
]);

/** Whether a file is a document the conversion reads, by its type or, for a type that says nothing, its extension. */
export const isDocument = (contentType: string, name: string): boolean => {
  const extension = name.includes(".")
    ? (name.split(".").at(-1) ?? "").toLowerCase()
    : "";

  return (
    DOCUMENT_TYPES.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "") ||
    DOCUMENT_EXTENSIONS.has(extension)
  );
};

const workersAiDocuments = (ai: Ai): DocumentReader => ({
  read: async ({ name, contentType, bytes }) => {
    try {
      const result = await ai.toMarkdown(
        {
          name,
          blob: new Blob([bytes], {
            type: contentType || "application/octet-stream",
          }),
        },
        {
          conversionOptions: {
            pdf: { images: { convert: false }, metadata: false },
            docx: { images: { convert: false } },
          },
        }
      );

      return result.format === "error"
        ? { ok: false, error: result.error }
        : { ok: true, text: result.data };
    } catch (error) {
      console.error("documents.read", { name, error: String(error) });

      return { ok: false, error: "The document could not be converted." };
    }
  },
});

/** The document reader for this Worker: a test's stand-in, else Workers AI through the AI binding, else none. */
export const documentsFor = (env: Env): DocumentReader | null => {
  if (env.DOCUMENTS) {
    return env.DOCUMENTS;
  }

  return env.AI ? workersAiDocuments(env.AI) : null;
};
