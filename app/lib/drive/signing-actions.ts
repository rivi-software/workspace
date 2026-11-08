/**
 * The server functions signing's pages call (#2974): a request sent from the editor, an action on a request (cancel,
 * remind, sign for the workspace) and the person's own signature saved or removed. A plain module: it imports the
 * `*.server.ts` modules for its handlers only.
 */
import { createServerFn } from "@tanstack/react-start";

import { formData, formPost } from "~/lib/forms";
import { field, stringOrNull } from "~/lib/guards";
import { appContext } from "~/lib/request.server";

import { originOf } from "./signing-events.server";
import {
  SigningError,
  cancelSigningRequest,
  createSigningRequest,
  deleteHandSignature,
  remindCustomer,
  saveHandSignature,
  signForRivi,
} from "./signing.server";
import type { NewSigningRequest } from "./signing.server";

export type SigningResult =
  | { ok: true; id?: string; message?: string }
  | { ok: false; error: string };

/** A request for signatures, as the editor sends it: the fields as placed, the workspace's values as filled in. */
export const sendSigningRequest = createServerFn({ method: "POST" })
  .validator((d: NewSigningRequest): NewSigningRequest => ({
    nodeId: stringOrNull(d?.nodeId) ?? "",
    customerName: stringOrNull(d?.customerName) ?? "",
    customerEmail: stringOrNull(d?.customerEmail) ?? "",
    signerId: stringOrNull(d?.signerId) ?? "",
    // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- the client posts what it likes, whatever the type says: only a literal true signs for the workspace
    autoSign: d?.autoSign === true,
    message: stringOrNull(d?.message) ?? "",
    fields: d?.fields,
    riviValues: d?.riviValues,
  }))
  .handler(async ({ data }): Promise<SigningResult> => {
    const { db, env, user, request } = await appContext();

    try {
      const { request: made } = await createSigningRequest(
        env,
        db,
        user,
        data,
        originOf(request)
      );

      return { ok: true, id: made.id };
    } catch (error) {
      if (error instanceof SigningError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

/**
 * One intent: `cancel` and `remind` (`id`, a request the person sent), `sign` (`id`, for the workspace: `signature`
 * drawn now, else the saved one), `save-signature` (`signature`) and `delete-signature`.
 */
export const signingAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SigningResult> => {
    const { db, env, user, request } = await appContext();
    const origin = originOf(request);
    const id = field(data, "id");

    try {
      switch (field(data, "intent")) {
        case "cancel": {
          await cancelSigningRequest(db, user, id, origin);

          return {
            ok: true,
            message: "The request is cancelled: its link no longer opens.",
          };
        }

        case "remind": {
          await remindCustomer(env, db, user, id, origin);

          return { ok: true, message: "The request was mailed again." };
        }

        case "sign": {
          await signForRivi(
            env,
            db,
            user,
            id,
            field(data, "signature") || null,
            origin
          );

          return {
            ok: true,
            message:
              "Signed. The signed copy is in Drive and on its way to the customer.",
          };
        }

        case "save-signature": {
          await saveHandSignature(db, user.id, field(data, "signature"));

          return { ok: true, message: "Your signature is saved." };
        }

        case "delete-signature": {
          await deleteHandSignature(db, user.id);

          return { ok: true, message: "Your signature is removed." };
        }

        default: {
          break;
        }
      }

      return { ok: false, error: "Unknown action." };
    } catch (error) {
      if (error instanceof SigningError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });
