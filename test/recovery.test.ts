import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { recoveryTokens, users } from "~/db/schema";
import {
  checkPassword,
  loginThrottled,
  recordLoginFailure,
} from "~/lib/auth.server";
import {
  EXPIRED_LINK,
  RecoveryError,
  addRecoveryAddress,
  confirmRecoveryAddress,
  listRecoveryAddresses,
  removeRecoveryAddress,
  requestPasswordReset,
  resendConfirmation,
  resetPassword,
} from "~/lib/recovery.server";
import { listPeople } from "~/lib/users.server";

import {
  db,
  defined,
  linkResets,
  mailbox,
  recordingEmail,
  rejection,
  rejectionIncludes,
  resetLink,
  tokenIn,
  withConfirmedAddress,
} from "./fixtures";

const NEW_PASSWORD = "a long new password";

const newPasswordFor = (token: string) => ({
  token,
  password: NEW_PASSWORD,
  confirm: NEW_PASSWORD,
});

describe("recovery addresses", () => {
  it("adds an address outside the mail domain behind the current password, and mails it a link", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("rec-add");
    const mail = recordingEmail();

    const add = (address: string, password = "password") =>
      addRecoveryAddress(mail.env, db, user, { address, password });

    observed.push(
      await rejectionIncludes(
        add("rec@gmail.com", "wrong"),
        "current password"
      ),
      await rejectionIncludes(
        add(`rec@${env.MAIL_DOMAIN}`),
        `outside ${env.MAIL_DOMAIN}`
      ),
      (await rejection(add("not an address"))) instanceof RecoveryError,
      {
        sent: mail.sent.length,
        "  Rec@Gmail.com ": await add("  Rec@Gmail.com "),
        sent2: mail.sent.length,
      }
    );
    const sent = defined(mail.sent[0]);
    expect(sent).toMatchObject({
      from: { email: `no-reply@${env.MAIL_DOMAIN}`, name: env.APP_NAME },
      to: ["rec@gmail.com"],
    });
    observed.push(
      sent.text?.includes(user.email),
      // The token rides in the fragment: the URL a request carries (and Workers Logs keep) has none.
      sent.text?.includes(`${env.APP_URL}/confirm-recovery#`),
      sent.text?.includes("?token"),
      sent.html?.includes(`href="${env.APP_URL}/confirm-recovery#`),
      await rejectionIncludes(
        add("rec@gmail.com"),
        "already one of your recovery addresses"
      )
    );
    await add("rec2@proton.me");
    await add("rec3@outlook.com");
    observed.push(
      await rejectionIncludes(add("rec4@icloud.com"), "3 recovery addresses")
    );
    const rows = await listRecoveryAddresses(db, user.id);
    observed.push(rows.map((r) => [r.address, r.confirmedAt]));

    expect(observed).toStrictEqual([
      // (await rejection(add("rec@gmail.com", "wrong")))?.message.includes("current password")
      true,
      // (await rejection(add(`rec@${env.MAIL_DOMAIN}`)))?.message.includes(`outside ${env.MAIL_...
      true,
      // (await rejection(add("not an address"))) instanceof RecoveryError
      true,
      // { sent: mail.sent.length, " Rec@Gmail.com ": await add(" Rec@Gmail.com "), sent2: mail....
      {
        sent: 0,
        "  Rec@Gmail.com ": "rec@gmail.com",
        sent2: 1,
      },
      // sent.text.includes(user.email)
      true,
      // sent.text.includes(`${env.APP_URL}/confirm-recovery#`)
      true,
      // sent.text.includes("?token")
      false,
      // sent.html.includes(`href="${env.APP_URL}/confirm-recovery#`)
      true,
      // (await rejection(add("rec@gmail.com")))?.message.includes("already one of your recovery...
      true,
      // (await rejection(add("rec4@icloud.com")))?.message.includes("3 recovery addresses")
      true,
      // rows.map((r) => [r.address, r.confirmedAt])
      [
        ["rec@gmail.com", null],
        ["rec2@proton.me", null],
        ["rec3@outlook.com", null],
      ],
    ]);
  });

  it("confirms an address with its link, once", async () => {
    const user = await mailbox("rec-confirm");
    const mail = recordingEmail();
    await addRecoveryAddress(mail.env, db, user, {
      address: "confirm@gmail.com",
      password: "password",
    });
    const token = tokenIn(mail.sent[0], "/confirm-recovery");
    expect({
      confirmRecoveryAddress: await confirmRecoveryAddress(db, ""),
      confirmRecoveryAddress2: await confirmRecoveryAddress(db, "not-a-token"),
      confirmRecoveryAddress3: await confirmRecoveryAddress(db, token),
      confirmRecoveryAddress4: await confirmRecoveryAddress(db, token),
    }).toStrictEqual({
      confirmRecoveryAddress: null,
      confirmRecoveryAddress2: null,
      confirmRecoveryAddress3: {
        address: "confirm@gmail.com",
      },
      confirmRecoveryAddress4: null,
    });
    const [row] = await listRecoveryAddresses(db, user.id);
    expect(row?.confirmedAt).toBeTruthy();
    await expect(
      resendConfirmation(mail.env, db, user, defined(row).id)
    ).rejects.toThrow("already confirmed");
    // An admin sees where the person's reset links go.
    const people = await listPeople(db);
    const person = people.find((p) => p.id === user.id);
    expect(person?.recoveryAddresses).toStrictEqual([
      { id: defined(row).id, address: "confirm@gmail.com", confirmed: true },
    ]);
  });

  it("voids the confirmation link of a removed address, and removes only the person's own", async () => {
    const user = await mailbox("rec-remove");
    const other = await mailbox("rec-remove-other");
    const mail = recordingEmail();
    await addRecoveryAddress(mail.env, db, user, {
      address: "remove@gmail.com",
      password: "password",
    });
    const [row] = await listRecoveryAddresses(db, user.id);
    await removeRecoveryAddress(db, other.id, defined(row).id);
    await expect(listRecoveryAddresses(db, user.id)).resolves.toHaveLength(1);
    await removeRecoveryAddress(db, user.id, defined(row).id);
    await expect(listRecoveryAddresses(db, user.id)).resolves.toHaveLength(0);
    await expect(
      confirmRecoveryAddress(db, tokenIn(mail.sent[0], "/confirm-recovery"))
    ).resolves.toBeNull();
  });

  it("voids the reset links already mailed when a confirmed address is removed, and only then", async () => {
    const user = await withConfirmedAddress("rec-remove-reset");
    const other = await mailbox("rec-remove-reset-other");
    const mail = recordingEmail();
    await addRecoveryAddress(mail.env, db, user, {
      address: "rec-remove-pending@gmail.com",
      password: "password",
    });
    const rows = await listRecoveryAddresses(db, user.id);
    const confirmed = defined(rows.find((r) => r.confirmedAt));
    const pending = defined(rows.find((r) => !r.confirmedAt));

    // Someone else's id does nothing, and a pending address was never sent a reset link.
    const kept = await resetLink(user);
    await removeRecoveryAddress(db, other.id, confirmed.id);
    await removeRecoveryAddress(db, user.id, pending.id);
    const keptResets = await linkResets(kept);

    const voided = await resetLink(user);
    await removeRecoveryAddress(db, user.id, confirmed.id);

    expect({
      keptResets,
      voidedResets: await linkResets(voided),
      left: await listRecoveryAddresses(db, user.id),
    }).toStrictEqual({ keptResets: true, voidedResets: false, left: [] });
  });

  it("sends a pending address its link again, up to five confirmation mails an hour", async () => {
    const user = await mailbox("rec-resend");
    const mail = recordingEmail();
    await addRecoveryAddress(mail.env, db, user, {
      address: "resend@gmail.com",
      password: "password",
    });
    const [row] = await listRecoveryAddresses(db, user.id);

    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each mail sent counts towards the hour's five before the next is asked for
      await resendConfirmation(mail.env, db, user, defined(row).id);
    }

    expect(mail.sent).toHaveLength(5);
    await expect(
      resendConfirmation(mail.env, db, user, defined(row).id)
    ).rejects.toThrow("Too many");
    // Every link sent keeps working until it expires.
    await expect(
      confirmRecoveryAddress(db, tokenIn(mail.sent[0], "/confirm-recovery"))
    ).resolves.toStrictEqual({
      address: "resend@gmail.com",
    });
  });

  it("keeps the address when its confirmation mail fails, so it can be sent again", async () => {
    const user = await mailbox("rec-fail");
    const failing = recordingEmail("sender not allowed");
    await expect(
      addRecoveryAddress(failing.env, db, user, {
        address: "fail@gmail.com",
        password: "password",
      })
    ).rejects.toThrow(
      "confirmation mail was not sent: EMAIL_FAILED sender not allowed"
    );
    const [row] = await listRecoveryAddresses(db, user.id);
    expect(row?.address).toBe("fail@gmail.com");
    const mail = recordingEmail();
    await expect(
      resendConfirmation(mail.env, db, user, defined(row).id)
    ).resolves.toBe("fail@gmail.com");
    expect(mail.sent).toHaveLength(1);
  });
});

describe("password reset", () => {
  it("mails a link only to the confirmed addresses of an active account", async () => {
    const user = await withConfirmedAddress("reset-send");
    const mail = recordingEmail();
    await addRecoveryAddress(mail.env, db, user, {
      address: "pending@gmail.com",
      password: "password",
    });
    mail.sent.length = 0;

    await requestPasswordReset(mail.env, db, `nobody@${env.MAIL_DOMAIN}`);
    await requestPasswordReset(mail.env, db, "not an address");
    expect(mail.sent).toHaveLength(0);

    await requestPasswordReset(mail.env, db, `  ${user.email.toUpperCase()} `);
    expect(mail.sent.map((m) => m.to)).toStrictEqual([
      ["reset-send@gmail.com"],
    ]);
    expect(mail.sent[0]).toMatchObject({
      subject: `Reset your ${env.APP_NAME} password`,
    });
    expect(defined(mail.sent[0]).text).toContain(
      `${env.APP_URL}/reset-password#`
    );

    // Without a confirmed address, or deactivated: nothing goes out, and the form says the same.
    const bare = await mailbox("reset-bare");
    await requestPasswordReset(mail.env, db, bare.email);
    await db.update(users).set({ active: false }).where(eq(users.id, user.id));
    await requestPasswordReset(mail.env, db, user.email);
    expect(mail.sent).toHaveLength(1);
  });

  it("sends at most five reset links an hour", async () => {
    const user = await withConfirmedAddress("reset-throttle");
    const mail = recordingEmail();

    for (let i = 0; i < 7; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each request counts towards the hour's five, so the throttle must see them one after another
      await requestPasswordReset(mail.env, db, user.email);
    }

    expect(mail.sent).toHaveLength(5);
  });

  it("sets the new password once it passes, then spends every link", async () => {
    const observed: unknown[] = [];

    const user = await withConfirmedAddress("reset-use");
    const earlier = await resetLink(user);
    const token = await resetLink(user);

    const reset = (input: {
      token?: string;
      password?: string;
      confirm?: string;
    }) =>
      resetPassword(env, db, {
        token,
        password: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
        ...input,
      });

    observed.push(
      await rejectionIncludes(
        reset({ password: "short", confirm: "short" }),
        "at least 12 characters"
      ),
      await rejectionIncludes(
        reset({ confirm: "something else entirely" }),
        "do not match"
      ),
      await rejectionIncludes(reset({ token: "not-a-token" }), EXPIRED_LINK)
    );
    // The rejected attempts did not spend the link.
    await reset({});

    observed.push(
      await checkPassword(db, user.id, NEW_PASSWORD),
      await rejectionIncludes(reset({}), EXPIRED_LINK),
      await rejectionIncludes(reset({ token: earlier }), EXPIRED_LINK)
    );

    expect(observed).toStrictEqual([
      // (await rejection(reset({ password: "short", confirm: "short" })))?.message.includes("at...
      true,
      // (await rejection(reset({ confirm: "something else entirely" })))?.message.includes("do ...
      true,
      // (await rejection(reset({ token: "not-a-token" })))?.message.includes(EXPIRED_LINK)
      true,
      // await checkPassword(db, user.id, NEW_PASSWORD)
      true,
      // (await rejection(reset({})))?.message.includes(EXPIRED_LINK)
      true,
      // (await rejection(reset({ token: earlier })))?.message.includes(EXPIRED_LINK)
      true,
    ]);
  });

  it("refuses an expired link and a deactivated account's link", async () => {
    const user = await withConfirmedAddress("reset-refuse");
    const expired = await resetLink(user);
    await db
      .update(recoveryTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(recoveryTokens.userId, user.id));

    await expect(
      resetPassword(env, db, newPasswordFor(expired))
    ).rejects.toThrow(EXPIRED_LINK);

    const token = await resetLink(user);
    await db.update(users).set({ active: false }).where(eq(users.id, user.id));
    await expect(resetPassword(env, db, newPasswordFor(token))).rejects.toThrow(
      "deactivated"
    );

    await expect(checkPassword(db, user.id, "password")).resolves.toBeTruthy();
  });

  it("lifts the sign-in throttle of the client that reset the password", async () => {
    const user = await withConfirmedAddress("reset-throttled-sign-in");
    const ip = "203.0.113.7";

    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the failures are counted in KV by a read and a write, so the ten must be recorded one after another
      await recordLoginFailure(env.KV, ip, user.email);
    }

    await expect(loginThrottled(env.KV, ip, user.email)).resolves.toBeTruthy();
    const token = await resetLink(user);
    await resetPassword(
      env,
      db,
      { token, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      ip
    );
    await expect(loginThrottled(env.KV, ip, user.email)).resolves.toBeFalsy();
  });
});
