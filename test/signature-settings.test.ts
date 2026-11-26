// The signatures on Settings → Account (`app/lib/mail/signature-settings.server.ts`): what the tab loads of them, and
// what their forms do, called as the route calls them. The signatures themselves are `signatures.test.ts`'s.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import {
  signatureIntent,
  signatureSettings,
} from "~/lib/mail/signature-settings.server";

import { db, defined, formOf, mailbox } from "./fixtures";

/** A signature form, as the Account tab posts it. */
const act = (user: User, fields: Record<string, string>) =>
  signatureIntent(db, env, user, formOf(fields));

describe("Settings → Account → Signatures", () => {
  it("adds, saves, chooses the defaults of and deletes the person's signatures", async () => {
    const user = await mailbox("signature-settings");

    const added = await act(user, {
      intent: "signature",
      name: "Work",
      text: "Sam\nWorkspace",
    });

    const second = await act(user, {
      intent: "signature",
      name: "Short",
      text: "— S",
    });

    const [work, short] = await signatureSettings(db, user);
    const workId = defined(work).id;
    const shortId = defined(short).id;

    const answers = {
      saved: await act(user, {
        intent: "signature",
        id: workId,
        name: "Work",
        text: "Sam\nWorkspace\nSupport",
        html: "<p>Sam</p>",
      }),
      defaults: await act(user, {
        intent: "default-signature",
        signatureId: shortId,
        replySignatureId: "",
      }),
      deleted: await act(user, { intent: "delete-signature", id: workId }),
      gone: await act(user, {
        intent: "signature",
        id: workId,
        name: "Work",
        text: "Again",
      }),
      nameless: await act(user, { intent: "signature", name: "", text: "x" }),
      unknown: await act(user, { intent: "password" }),
    };

    expect({
      added,
      second,
      answers,
      left: await signatureSettings(db, user),
    }).toStrictEqual({
      added: { message: "Signature added." },
      second: { message: "Signature added." },
      answers: {
        saved: { message: "Saved." },
        defaults: { message: "Saved." },
        deleted: { message: "Signature deleted." },
        gone: { error: "That signature no longer exists." },
        nameless: { error: "A signature needs a name." },
        unknown: {},
      },
      left: [
        {
          id: shortId,
          name: "Short",
          text: "— S",
          html: null,
          isDefault: true,
          isReplyDefault: false,
        },
      ],
    });
  });

  it("loads only the person's own signatures", async () => {
    const owner = await mailbox("signature-owner");
    const other = await mailbox("signature-other");

    await act(owner, { intent: "signature", name: "Mine", text: "Owner" });

    const theirs = await signatureSettings(db, other);
    const mine = await signatureSettings(db, owner);

    expect({
      theirs,
      mine: mine.map(({ name, isDefault }) => ({ name, isDefault })),
    }).toStrictEqual({
      theirs: [],
      mine: [{ name: "Mine", isDefault: true }],
    });
  });
});
