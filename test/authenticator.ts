import { env } from "cloudflare:workers";

import type { User } from "~/db/schema";
import { authFor } from "~/lib/auth.server";

import { PASSWORD, defined, sessionFor } from "./fixtures";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The text an `otpauth://` URI's `secret` encodes (RFC 4648 base32, no padding), as Better Auth's TOTP reads it. */
const base32Text = (encoded: string): string => {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of encoded.toUpperCase().replaceAll("=", "")) {
    const index = BASE32.indexOf(char);

    if (index === -1) {
      throw new Error(`"${char}" is not base32`);
    }

    // oxlint-disable-next-line eslint/no-bitwise -- base32 is five bits a character, read into bytes
    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      // oxlint-disable-next-line eslint/no-bitwise -- the top eight of the bits read so far
      bytes.push((value >> bits) & 0xff);
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
};

/**
 * Turns on the person's authenticator app through Better Auth's own enrolment (Settings → Account): the password,
 * then a first code. Answers the app itself (`code`, the code it shows now) and the backup codes.
 */
export const enrolAuthenticator = async (user: User) => {
  const auth = await authFor(env);

  const headers = new Headers({
    cookie: await sessionFor(user),
    origin: new URL(env.APP_URL).origin,
  });

  const enabled = await auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers,
  });

  if (enabled.method !== "totp") {
    throw new Error("Better Auth enrolled no authenticator app");
  }

  const secret = base32Text(
    defined(
      new URL(enabled.totpURI).searchParams.get("secret"),
      "the TOTP secret"
    )
  );

  const code = async () => {
    const generated = await auth.api.generateTOTP({ body: { secret } });

    return generated.code;
  };

  await auth.api.verifyTOTP({ body: { code: await code() }, headers });

  return { code, backupCodes: enabled.backupCodes };
};

/** The `cookie` header a browser sends after an answer's `Set-Cookie` headers (a cleared cookie left out). */
export const cookiesOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
