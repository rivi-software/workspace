import { sendMail } from "@rivi-software/workers-mail";

import { textToHtml } from "../text";

/**
 * Drive's mail from `no-reply@` on the mail domain, as the recovery mail: the domain is onboarded in SES and Email
 * Service. An invite (`links.server.ts`), a visitor's code (`visitor.server.ts`) and signing's notices
 * (`signing.server.ts`) go out through it; it has a module of its own so the three can share it without importing
 * each other.
 */
export const mailOut = async (
  env: Env,
  to: string,
  name: string,
  subject: string,
  text: string
) => {
  await sendMail(env, {
    from: { email: `no-reply@${env.MAIL_DOMAIN}`, name },
    to,
    subject,
    text,
    html: textToHtml(text),
  });
};
