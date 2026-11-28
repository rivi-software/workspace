/**
 * The JSON Web Tokens the relay signs and checks: ES256 to APNs (Apple's provider token), RS256 to Google (a service
 * account's grant for FCM), and ES256 from a workspace (its VAPID claim, RFC 8292). WebCrypto's ECDSA signature is the
 * raw `r || s` a JWS carries, so no DER conversion is needed.
 */
import { base64Decode, base64UrlEncode, pemBody, utf8 } from "./bytes";
import { numberOrNull, parseJsonObject, stringOrNull } from "./json";

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** What a token's header and claims carry: names to strings or numbers. */
export type JwtFields = Record<string, string | number>;

const encodeJson = (value: JwtFields): string =>
  base64UrlEncode(utf8(JSON.stringify(value)));

/** A PKCS #8 private key from its PEM, for ES256 (Apple's `.p8`) or RS256 (a Google service account). */
export const importPrivateKey = (
  pem: string,
  alg: "ES256" | "RS256"
): Promise<CryptoKey> => {
  const der = pemBody(pem);

  if (!der) {
    return Promise.reject(new Error(`The ${alg} private key is not PEM.`));
  }

  return crypto.subtle.importKey(
    "pkcs8",
    der,
    alg === "ES256" ? ES256 : RS256,
    false,
    ["sign"]
  );
};

export const signJwt = async (
  header: { alg: "ES256" | "RS256"; kid?: string; typ?: string },
  claims: JwtFields,
  key: CryptoKey
): Promise<string> => {
  const input = `${encodeJson(header)}.${encodeJson(claims)}`;

  const algorithm =
    header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : RS256;

  const signature = await crypto.subtle.sign(algorithm, key, utf8(input));

  return `${input}.${base64UrlEncode(signature)}`;
};

/** A P-256 public key in its uncompressed form (65 bytes, `0x04 || x || y`), as a VAPID `k` and a subscription name it. */
export const importRawPublicKey = async (
  raw: Uint8Array<ArrayBuffer>
): Promise<CryptoKey | null> => {
  if (raw.length !== 65 || raw[0] !== 4) {
    return null;
  }

  try {
    return await crypto.subtle.importKey("raw", raw, ES256, false, ["verify"]);
  } catch {
    return null;
  }
};

/** The claims a VAPID token makes (RFC 8292 §2): whom it is for, until when, and who sends. */
export interface VapidClaims {
  aud: string | null;
  exp: number | null;
  sub: string | null;
}

const decodePart = (part: string) => {
  const bytes = base64Decode(part);

  return parseJsonObject(bytes ? new TextDecoder().decode(bytes) : "");
};

/** The claims of an ES256 token `key` signed, or null when it is malformed, of another algorithm or not its signature. */
export const verifyEs256 = async (
  token: string,
  key: CryptoKey
): Promise<VapidClaims | null> => {
  const [header, claims, signature, ...rest] = token.split(".");

  if (!header || !claims || !signature || rest.length > 0) {
    return null;
  }

  const sig = base64Decode(signature);

  if (stringOrNull(decodePart(header).alg) !== "ES256" || sig?.length !== 64) {
    return null;
  }

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    utf8(`${header}.${claims}`)
  );

  if (!valid) {
    return null;
  }

  const body = decodePart(claims);

  return {
    aud: stringOrNull(body.aud),
    exp: numberOrNull(body.exp),
    sub: stringOrNull(body.sub),
  };
};
