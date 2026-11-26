/**
 * A person's mail signatures in Settings, which show on the Account tab: what the tab loads of them
 * (`signatureSettings`) and what their forms do (`signatureIntent`), apart from the route so the tests call both. The
 * signatures themselves are `signatures.server.ts`'s.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { field, optionalField } from "~/lib/guards";
import type { SettingsResult } from "~/lib/settings";

import {
  SignatureError,
  deleteSignature,
  listSignatures,
  saveSignature,
  setDefaultSignatures,
} from "./signatures.server";

/** The person's signatures, the defaults for a new message and for a reply marked. */
export const signatureSettings = async (db: Database, user: User) => {
  const rows = await listSignatures(db, user.id);

  return rows.map(({ id, name, text, html, isDefault, isReplyDefault }) => ({
    id,
    name,
    text,
    html,
    isDefault,
    isReplyDefault,
  }));
};

/**
 * A signature form: `signature` adds one, or saves the one its `id` names (`html` only when the form posts it),
 * `default-signature` chooses the defaults for a new message and a reply (none when left empty), and
 * `delete-signature` deletes one. An intent it does not know answers nothing.
 */
export const signatureIntent = async (
  db: Database,
  _env: Env,
  user: User,
  form: FormData
): Promise<SettingsResult> => {
  try {
    switch (field(form, "intent")) {
      case "signature": {
        const id = optionalField(form, "id");

        await saveSignature(db, user.id, {
          id,
          name: field(form, "name"),
          text: field(form, "text"),
          html: form.has("html") ? field(form, "html") : null,
        });

        return { message: id ? "Saved." : "Signature added." };
      }

      case "default-signature": {
        await setDefaultSignatures(db, user.id, {
          new: optionalField(form, "signatureId"),
          reply: optionalField(form, "replySignatureId"),
        });

        return { message: "Saved." };
      }

      case "delete-signature": {
        await deleteSignature(db, user.id, field(form, "id"));

        return { message: "Signature deleted." };
      }

      default: {
        return {};
      }
    }
  } catch (error) {
    if (error instanceof SignatureError) {
      return { error: error.message };
    }

    throw error;
  }
};
