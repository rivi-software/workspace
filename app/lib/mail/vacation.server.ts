import { sendMail } from "@rivi-software/workers-mail";

import type { User } from "~/db/schema";
import { errorMessage } from "~/lib/guards";

import { textToHtml } from "../text";
import { replySubject } from "./threading";

/** How long one sender waits for another automatic reply. */
export const VACATION_REPLY_DAYS = 4;

/** Whether the responder answers right now: switched on, and inside its dates when they are set. */
export const vacationActive = (
  user: Pick<User, "vacationOn" | "vacationFrom" | "vacationUntil">,
  now = new Date()
): boolean => {
  if (!user.vacationOn) {
    return false;
  }

  const day = now.toISOString().slice(0, 10);

  if (user.vacationFrom && day < user.vacationFrom) {
    return false;
  }

  if (user.vacationUntil && day > user.vacationUntil) {
    return false;
  }

  return true;
};

/** A header value, the first of its name, as postal-mime lists them. */
export const headerOf = (
  headers: { key: string; value: string }[],
  name: string
) => headers.find((h) => h.key === name.toLowerCase())?.value ?? null;

/**
 * Mail no responder should answer: what a machine sent (RFC 3834 `Auto-Submitted`, Microsoft's
 * `X-Auto-Response-Suppress`), bulk and list mail (`Precedence`, `List-Id`, `List-Unsubscribe`), bounces and the
 * addresses nobody reads.
 */
export const isAutomatedMail = (
  headers: { key: string; value: string }[],
  from: string
): boolean => {
  const auto = headerOf(headers, "Auto-Submitted");

  if (auto && !/^no\b/iu.test(auto.trim())) {
    return true;
  }

  if (headerOf(headers, "X-Auto-Response-Suppress")) {
    return true;
  }

  if (headerOf(headers, "X-Autoreply") || headerOf(headers, "X-Autorespond")) {
    return true;
  }

  const precedence = headerOf(headers, "Precedence");

  if (
    precedence &&
    /^(?:bulk|list|junk|auto_reply)/iu.test(precedence.trim())
  ) {
    return true;
  }

  if (headerOf(headers, "List-Id") || headerOf(headers, "List-Unsubscribe")) {
    return true;
  }

  if (
    /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?|alerts?)[@+.-]/iu.test(
      from
    )
  ) {
    return true;
  }

  return false;
};

export interface VacationInput {
  messageId: string;
  references: string[];
  from: { email: string; name: string | null };
  subject: string;
}

/**
 * Answer a message with the owner's vacation text, once per sender in `VACATION_REPLY_DAYS` (KV remembers who was
 * answered). Sent straight through the binding and not filed: an automatic reply is no conversation of the owner's.
 */
export const maybeAutoReply = async (
  env: Env,
  user: User,
  own: Set<string>,
  mail: VacationInput
): Promise<boolean> => {
  if (!vacationActive(user)) {
    return false;
  }

  const sender = mail.from.email.toLowerCase();

  if (own.has(sender)) {
    return false;
  }

  const key = `vacation:${user.id}:${sender}`;

  if (await env.KV.get(key)) {
    return false;
  }

  const text = user.vacationText.trim();

  if (!text) {
    return false;
  }

  const subject =
    user.vacationSubject.trim() ||
    `Automatic reply: ${replySubject(mail.subject)}`;

  try {
    await sendMail(env, {
      from: { email: user.email, name: user.name },
      to: { email: sender, name: mail.from.name },
      subject,
      text,
      html: textToHtml(text),
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        Precedence: "auto_reply",
        "In-Reply-To": mail.messageId,
        References: [...mail.references, mail.messageId].join(" "),
      },
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "vacation.failed",
        user: user.id,
        error: errorMessage(error),
      })
    );

    return false;
  }

  await env.KV.put(key, new Date().toISOString(), {
    expirationTtl: VACATION_REPLY_DAYS * 86_400,
  });

  return true;
};
