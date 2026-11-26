/** HMAC-signed JWTs (`HS512`, `HS256`): what Duo signs and expects, with the client secret both sides hold. */
import { base64UrlEncode, constantTimeEqual } from "~/lib/crypto";
import { decodeJwt } from "~/lib/sso/jwt";
import type { JwtClaims } from "~/lib/sso/jwt";

const isNumber = (value: unknown): value is number => typeof value === "number";

export type HmacAlg = "HS512" | "HS256";

const HASH: Record<HmacAlg, "SHA-512" | "SHA-256"> = {
  HS512: "SHA-512",
  HS256: "SHA-256",
};

const encoder = new TextEncoder();

const hmacKey = (secret: string, alg: HmacAlg): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: HASH[alg] },
    false,
    ["sign"]
  );

const hmac = async (
  secret: string,
  alg: HmacAlg,
  data: string
): Promise<string> => {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, alg),
    encoder.encode(data)
  );

  return base64UrlEncode(signature);
};

export const signHmacJwt = async (
  claims: JwtClaims,
  secret: string,
  options: { alg?: HmacAlg } = {}
): Promise<string> => {
  const alg = options.alg ?? "HS512";
  const signed = `${base64UrlEncode(JSON.stringify({ alg, typ: "JWT" }))}.${base64UrlEncode(JSON.stringify(claims))}`;

  return `${signed}.${await hmac(secret, alg, signed)}`;
};

export interface VerifyHmacOptions {
  issuer: string;
  audience: string;
  /** Default `["HS512"]`. */
  algorithms?: HmacAlg[];
  now?: number;
  clockSkewSeconds?: number;
}

/** The claims of an HMAC JWT whose signature, issuer, audience and times check out, else `null`. */
export const verifyHmacJwt = async (
  token: string,
  secret: string,
  options: VerifyHmacOptions
): Promise<JwtClaims | null> => {
  const decoded = decodeJwt(token);

  if (!decoded) {
    return null;
  }

  const allowed = options.algorithms ?? ["HS512"];
  const alg = allowed.find((algorithm) => algorithm === decoded.header.alg);

  if (!alg) {
    return null;
  }

  // `signed` is the token's header and payload; the signature follows its dot.
  const signature = token.slice(decoded.signed.length + 1);

  if (!constantTimeEqual(signature, await hmac(secret, alg, decoded.signed))) {
    return null;
  }

  const { claims } = decoded;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? 60;

  if (claims.iss !== options.issuer) {
    return null;
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (!audiences.includes(options.audience)) {
    return null;
  }

  if (!isNumber(claims.exp) || claims.exp + skew < now) {
    return null;
  }

  if (isNumber(claims.nbf) && claims.nbf - skew > now) {
    return null;
  }

  if (isNumber(claims.iat) && claims.iat - skew > now) {
    return null;
  }

  return claims;
};
