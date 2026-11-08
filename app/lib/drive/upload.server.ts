import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";

import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { defined, isJsonObject, numberOr, stringOrNull } from "~/lib/guards";

import { SIMPLE_UPLOAD_LIMIT, UPLOAD_PART_SIZE } from "./drive";
import {
  DriveError,
  abortUpload,
  finishUpload,
  nodeRow,
  startUpload,
  uploadPart,
} from "./drive.server";

// oxlint-disable-next-line anti-slop/no-object-parameters -- the JSON answer of each route below, each its own shape: `Response.json` serialises any object
const answer = (data: object, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** The JSON object a request carries, or null when the body is no JSON or no object. */
const readObject = async (request: Request) => {
  try {
    const parsed: unknown = await request.json();

    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const problem = (error: string, status = 400) =>
  answer({ ok: false, error }, status);

/** The file as a row of its listing (docs/API.md `DriveRow`), which the console's uploader reads its id from and the app on a phone decodes whole. */
const nodeView = async (db: Database, userId: string, id: string) =>
  defined(await nodeRow(db, userId, id), "the file just stored");

const put = async (
  request: Request,
  env: Env,
  db: Database,
  user: User
): Promise<Response> => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    const partNumber = Number(url.searchParams.get("part"));
    const length = Number(request.headers.get("content-length") ?? "0");

    if (length > UPLOAD_PART_SIZE) {
      return problem("A part is 16 MB at most.", 413);
    }

    const part = await uploadPart(
      env,
      db,
      user.id,
      id,
      partNumber,
      await request.arrayBuffer()
    );

    return answer({ ok: true, part });
  }

  const length = request.headers.get("content-length");

  if (!length || !/^\d+$/u.test(length)) {
    return problem("The file's size is needed.", 411);
  }

  const size = Number(length);

  if (size > SIMPLE_UPLOAD_LIMIT) {
    return problem("Send a file this large in parts.", 413);
  }

  if (!request.body) {
    return problem("The file is missing.");
  }

  const { node } = await startUpload(db, env, user.id, {
    parentId: url.searchParams.get("folder") || null,
    name: url.searchParams.get("name") ?? "",
    size,
    contentType: request.headers.get("content-type"),
    multipart: false,
  });

  try {
    await env.DRIVE.put(defined(node.r2Key, "the r2 key"), request.body, {
      httpMetadata: { contentType: node.contentType },
    });
    const done = await finishUpload(env, db, user.id, node.id);

    return answer({ ok: true, node: await nodeView(db, user.id, done.id) });
  } catch (error) {
    await abortUpload(env, db, user.id, node.id);
    throw error;
  }
};

const post = async (
  request: Request,
  env: Env,
  db: Database,
  user: User
): Promise<Response> => {
  const body = await readObject(request);

  if (!body) {
    return problem("Expected JSON.");
  }

  const str = (k: string) => stringOrNull(body[k]) ?? "";

  switch (body.intent) {
    case "start": {
      const { node, uploadId } = await startUpload(db, env, user.id, {
        parentId: str("folder") || null,
        name: str("name"),
        size: Number(body.size),
        contentType: str("type") || null,
        multipart: true,
      });

      return answer({
        ok: true,
        id: node.id,
        uploadId,
        partSize: UPLOAD_PART_SIZE,
      });
    }

    case "finish": {
      const sent = body.parts;

      const parts = Array.isArray(sent)
        ? sent.flatMap((p) => {
            if (!isJsonObject(p)) {
              return [];
            }

            const etag = stringOrNull(p.etag);
            const partNumber = numberOr(p.partNumber, Number.NaN);

            return etag !== null && Number.isInteger(partNumber)
              ? [{ partNumber, etag }]
              : [];
          })
        : [];

      const node = await finishUpload(env, db, user.id, str("id"), parts);

      return answer({ ok: true, node: await nodeView(db, user.id, node.id) });
    }

    case "abort": {
      await abortUpload(env, db, user.id, str("id"));

      return answer({ ok: true });
    }

    default: {
      return problem("Unknown intent.");
    }
  }
};

/**
 * Files on their way into Drive, for whoever the caller let through (the console's uploader through its session,
 * `app/routes/api/drive.upload.ts`; the app on a phone through its token, `app/lib/api/drive.server.ts`):
 *
 *   PUT  …/upload?folder=<id>&name=<name>      the whole file as the body (up to SIMPLE_UPLOAD_LIMIT)
 *   POST …/upload  {intent:"start", …}         a large file: its row, and R2's multipart upload opened
 *   PUT  …/upload?id=<node>&part=<n>           one part of it (UPLOAD_PART_SIZE, the last one smaller)
 *   POST …/upload  {intent:"finish", id, parts} the parts joined; the file is whole
 *   POST …/upload  {intent:"abort", id}         given up: parts and row dropped
 *
 * The server module checks the folder may be written to. A body streams straight into the bucket, never through
 * memory as a whole. A `DriveError` is the person's mistake (`400`); anything else is reported and a `500`.
 */
export const handleDriveUpload = async (
  request: Request,
  env: Env,
  db: Database,
  user: User
): Promise<Response> => {
  try {
    if (request.method === "PUT") {
      return await put(request, env, db, user);
    }

    if (request.method === "POST") {
      return await post(request, env, db, user);
    }

    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "PUT, POST" },
    });
  } catch (error) {
    if (error instanceof DriveError) {
      return problem(error.message);
    }

    console.error(
      JSON.stringify({ event: "drive.upload.error", error: String(error) })
    );
    captureServerException(error, { request, distinctId: user.id });

    return problem("The upload failed.", 500);
  }
};
