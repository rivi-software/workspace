/**
 * The Autocrypt header (Autocrypt Level 1, §2.1): a sender's public key carried on their mail, so the people they
 * write to can encrypt back without looking it up. Read from mail that arrives (`inbound.server.ts`, which only
 * believes it of mail that passed DKIM) and written on what is sent signed or encrypted (`outbound.server.ts`).
 */
import { CRLF, base64Lines } from "./mime";

export interface Autocrypt {
  /** Lower-cased. */
  addr: string;
  /** `prefer-encrypt=mutual`: the sender would rather get encrypted mail. */
  preferEncrypt: boolean;
  /** The key, as OpenPGP packets. */
  keydata: Uint8Array;
}

/**
 * The header's value, or null when it is not a valid one: `addr` and `keydata` are required, an attribute that starts
 * with `_` is ignored, and any other unknown attribute makes the whole header one to ignore (§2.1.1).
 */
export const parseAutocrypt = (value: string | null): Autocrypt | null => {
  if (!value) {
    return null;
  }

  let addr: string | null = null;
  let keydata: string | null = null;
  let preferEncrypt = false;

  for (const attribute of value.split(";")) {
    const eq = attribute.indexOf("=");

    if (eq === -1) {
      continue;
    }

    const name = attribute.slice(0, eq).trim().toLowerCase();
    const v = attribute.slice(eq + 1).trim();

    if (name === "addr") {
      addr = v.toLowerCase();
    } else if (name === "keydata") {
      keydata = v.replaceAll(/\s/gu, "");
    } else if (name === "prefer-encrypt") {
      preferEncrypt = v === "mutual";
    } else if (!name.startsWith("_")) {
      return null;
    }
  }

  if (!addr || !keydata) {
    return null;
  }

  try {
    return {
      addr,
      preferEncrypt,
      keydata: Uint8Array.from(atob(keydata), (c) => c.codePointAt(0) ?? 0),
    };
  } catch {
    return null;
  }
};

/** The header's value for a key, folded in lines a header can carry (CRLF then a space). */
export const autocryptHeader = (addr: string, key: Uint8Array): string =>
  `addr=${addr}; keydata=${CRLF} ${base64Lines(key).split(CRLF).join(`${CRLF} `)}`;
