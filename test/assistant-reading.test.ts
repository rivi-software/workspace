import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import { stepView } from "~/lib/assistant/assistant";
import type { Json } from "~/lib/assistant/assistant";
import { MAX_FILE_CHARS } from "~/lib/assistant/reading.server";
import { isDocument } from "~/lib/documents.server";
import type { DocumentReader } from "~/lib/documents.server";
import { finishUpload, startUpload } from "~/lib/drive/drive.server";
import { stringOrNull } from "~/lib/guards";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";

import { ask, toolPart } from "./assistant-turn";
import { db, defined, mail, mailbox } from "./fixtures";

const PDF = "application/pdf";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A document reader that answers what a test says each file holds, by its name, and records what it was handed. A
 * name without an answer is a document the conversion cannot read.
 */
const fakeDocuments = (texts: { [name: string]: string }) => {
  const read: { name: string; contentType: string; bytes: number }[] = [];

  const reader: DocumentReader = {
    read: ({ name, contentType, bytes }) => {
      read.push({ name, contentType, bytes: bytes.byteLength });
      const text = texts[name];

      return Promise.resolve(
        text === undefined
          ? { ok: false, error: "The file is protected by a password." }
          : { ok: true, text }
      );
    },
  };

  return { read, env: { ...env, DOCUMENTS: reader } };
};

/** A file in the person's Drive with these bytes. */
const inDrive = async (
  userId: string,
  name: string,
  contentType: string,
  bytes: Uint8Array
) => {
  const { node } = await startUpload(db, env, userId, {
    parentId: null,
    name,
    size: bytes.byteLength,
    contentType,
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes, {
    httpMetadata: { contentType },
  });

  return finishUpload(env, db, userId, node.id);
};

const bytesOf = (text: string) => new TextEncoder().encode(text);

/** The Worker's env with the AI binding as given: none, for a Worker that has nothing to convert a document with. */
const laid = (over: { AI?: Ai }): Env => {
  // SAFETY: test-only: the generated `Env` always declares the binding, and `documentsFor` asks whether it is there.
  const made = { ...env, ...over } as Env;

  return made;
};

/** One call of a reading tool in a turn of its own, and what it answered. */
const reading = async (
  user: User,
  tool: "read_file" | "read_attachment",
  input: { [key: string]: Json },
  over: Env
) => {
  const turn = await ask(
    user,
    "Read it.",
    [{ tool, input }, { text: "Read." }],
    {
      env: over,
    }
  );

  return defined(toolPart(turn.last.parts, tool), "the step");
};

describe("the assistant reading documents", () => {
  let ann: User;
  let bo: User;
  beforeAll(async () => {
    ann = await mailbox("read-ann", "Ann");
    bo = await mailbox("read-bo", "Bo");
  });

  it("reads a PDF and an office document in Drive through the document reader, and a text file without it", async () => {
    const documents = fakeDocuments({
      "contract.pdf": "# Contract\nThe term is three years.",
      "quote.docx": "Quote: 12 seats at 5 euro.",
    });

    const pdf = await inDrive(ann.id, "contract.pdf", PDF, bytesOf("%PDF-1.7"));
    const docx = await inDrive(ann.id, "quote.docx", DOCX, bytesOf("PK"));

    const csv = await inDrive(
      ann.id,
      "seats.csv",
      "text/csv",
      bytesOf("a,b\n1,2")
    );

    const png = await inDrive(ann.id, "logo.png", "image/png", bytesOf("PNG"));

    const [readPdf, readDocx, readCsv, readPng, byBo] = [
      await reading(ann, "read_file", { fileId: pdf.id }, documents.env),
      await reading(ann, "read_file", { fileId: docx.id }, documents.env),
      await reading(ann, "read_file", { fileId: csv.id }, documents.env),
      await reading(ann, "read_file", { fileId: png.id }, documents.env),
      await reading(bo, "read_file", { fileId: pdf.id }, documents.env),
    ];

    expect({
      pdf: [readPdf.output.text, readPdf.output.truncated, readPdf.output.link],
      docx: readDocx.output.text,
      csv: readCsv.output.text,
      png: readPng.output.error,
      // The gate comes first: a stranger's file never reaches the reader.
      byBo: byBo.output.error,
      handed: documents.read,
      line: stepView(readPdf).label,
    }).toStrictEqual({
      pdf: [
        "# Contract\nThe term is three years.",
        false,
        `/drive/d/${pdf.id}`,
      ],
      docx: "Quote: 12 seats at 5 euro.",
      csv: "a,b\n1,2",
      png: "“logo.png” is image/png, which cannot be read as text.",
      byBo: "No such file, or it is out of reach.",
      handed: [
        { name: "contract.pdf", contentType: PDF, bytes: 8 },
        { name: "quote.docx", contentType: DOCX, bytes: 2 },
      ],
      line: "Read “contract.pdf”",
    });
  });

  it("says why a document has no text to give: too large, refused, empty, cut off, or no reader", async () => {
    const documents = fakeDocuments({
      "scan.pdf": "  ",
      "long.pdf": "x".repeat(MAX_FILE_CHARS + 5),
    });

    const scan = await inDrive(ann.id, "scan.pdf", PDF, bytesOf("%PDF"));
    const long = await inDrive(ann.id, "long.pdf", PDF, bytesOf("%PDF"));
    const locked = await inDrive(ann.id, "locked.pdf", PDF, bytesOf("%PDF"));

    const huge = await inDrive(
      ann.id,
      "huge.pdf",
      PDF,
      new Uint8Array(4 * 1024 * 1024 + 1)
    );

    const [readScan, readLong, readLocked, readHuge, unread] = [
      await reading(ann, "read_file", { fileId: scan.id }, documents.env),
      await reading(ann, "read_file", { fileId: long.id }, documents.env),
      await reading(ann, "read_file", { fileId: locked.id }, documents.env),
      await reading(ann, "read_file", { fileId: huge.id }, documents.env),
      // A Worker without the AI binding has nothing to convert with.
      await reading(
        ann,
        "read_file",
        { fileId: scan.id },
        laid({ AI: undefined })
      ),
    ];

    expect({
      scan: readScan.output.error,
      long: [
        (stringOrNull(readLong.output.text) ?? "").length,
        readLong.output.truncated,
      ],
      locked: readLocked.output.error,
      huge: readHuge.output.error,
      unread: unread.output.error,
      // The huge file was refused before its bytes were loaded.
      handed: documents.read.map((r) => r.name),
    }).toStrictEqual({
      scan: "“scan.pdf” holds no text to read: it may be a scan or pictures only.",
      long: [MAX_FILE_CHARS, true],
      locked:
        "“locked.pdf” could not be read: The file is protected by a password.",
      huge: "“huge.pdf” is too large to read: more than 4 MB.",
      unread: "No document reader is set up to read this kind of file.",
      handed: ["scan.pdf", "long.pdf", "locked.pdf"],
    });
  });

  it("reads a file of a message in the person's mailbox by its name, the newest of that name, and nobody else's", async () => {
    const documents = fakeDocuments({ "invoice.pdf": "Invoice 42: 300 euro." });

    const withFiles = (text: string) =>
      mail({
        to: [{ email: ann.email, name: null }],
        subject: "Invoice for October",
        attachments: [
          {
            filename: "invoice.pdf",
            mimeType: PDF,
            content: bytesOf(`%PDF ${text}`),
            contentId: null,
            inline: false,
          },
          {
            filename: "Notes.TXT",
            mimeType: "text/plain",
            content: bytesOf(text),
            contentId: null,
            inline: false,
          },
        ],
      });

    const first = await ingestInboundEmail(
      env,
      null,
      withFiles("first notes"),
      ann.email
    );

    if (first.status !== "stored") {
      throw new Error(first.status);
    }

    const id = first.threadId;
    const at = { conversationId: id };

    const [pdf, notes, missing, byBo] = [
      await reading(
        ann,
        "read_attachment",
        { ...at, name: "invoice.pdf" },
        documents.env
      ),
      await reading(
        ann,
        "read_attachment",
        { ...at, name: "notes.txt" },
        documents.env
      ),
      await reading(
        ann,
        "read_attachment",
        { ...at, name: "other.pdf" },
        documents.env
      ),
      await reading(
        bo,
        "read_attachment",
        { ...at, name: "invoice.pdf" },
        documents.env
      ),
    ];

    expect({
      pdf: [pdf.output.name, pdf.output.text, pdf.output.link],
      notes: [notes.output.name, notes.output.text],
      missing: missing.output.error,
      byBo: byBo.output.error,
      line: [stepView(pdf).label, stepView(pdf).link],
    }).toStrictEqual({
      pdf: ["invoice.pdf", "Invoice 42: 300 euro.", `/mail/t/${id}`],
      notes: ["Notes.TXT", "first notes"],
      missing: "No such file in that conversation of this mailbox.",
      byBo: "No such file in that conversation of this mailbox.",
      line: ["Read “invoice.pdf”", `/mail/t/${id}`],
    });
  });

  it("knows a document by its type, or by its name when the type says nothing", () => {
    expect([
      isDocument(PDF, "a"),
      isDocument("application/octet-stream", "Contract.PDF"),
      isDocument("application/octet-stream", "sheet.xlsx"),
      isDocument("text/plain", "notes.txt"),
      isDocument("image/png", "scan.png"),
      isDocument("application/octet-stream", "pdf"),
    ]).toStrictEqual([true, true, true, false, false, false]);
  });
});
