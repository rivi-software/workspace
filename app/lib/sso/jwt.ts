/**
 * ES256 JWTs (ECDSA P-256 over SHA-256), the ID and access tokens the identity provider signs (`provider.server.ts`)
 * and the key set it publishes: from `@rivi/sso` in the RIVI monorepo, which the single sign-on was ported from.
 */
import {
  base64UrlDecode,
  base64UrlDecodeString,
  base64UrlEncode,
  randomToken,
} from "~/lib/crypto";
import { isJsonObject } from "~/lib/guards";

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

/** A JSON Web Key as a JWKS lists it; `d` is only on the private half. */
export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  ext?: boolean;
}

/** An ES256 (ECDSA P-256) key pair the issuer signs with; the public half is what the JWKS lists. */
export interface SigningKey {
  kid: string;
  alg: "ES256";
  privateJwk: Jwk;
  publicJwk: Jwk;
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- claims are whatever JSON the issuer signed; each reader checks the claim it needs with a type guard
export type JwtClaims = Record<string, unknown>;

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

export const generateSigningKey = async (
  kid = randomToken(12)
): Promise<SigningKey> => {
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  // SAFETY: exportKey in the "jwk" format answers a JWK, and every JWK names its `kty` (RFC 7517 §4.1).
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk;
  // SAFETY: as for the private key above.
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;

  return {
    kid,
    alg: "ES256",
    privateJwk: {
      kty: priv.kty,
      crv: priv.crv,
      x: priv.x,
      y: priv.y,
      d: priv.d,
    },
    publicJwk: {
      kty: pub.kty,
      crv: pub.crv,
      x: pub.x,
      y: pub.y,
      kid,
      alg: "ES256",
      use: "sig",
    },
  };
};

/** Signs `claims` as a compact JWS with ES256; `typ` names the token kind (`JWT`, `at+jwt`). */
export const signJwt = async (
  claims: JwtClaims,
  key: { kid: string; privateJwk: Jwk },
  options: { typ?: string } = {}
): Promise<string> => {
  const header = { alg: "ES256", typ: options.typ ?? "JWT", kid: key.kid };
  const signed = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  const imported = await crypto.subtle.importKey(
    "jwk",
    key.privateJwk,
    ALG,
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    SIGN,
    imported,
    encoder.encode(signed)
  );

  return `${signed}.${base64UrlEncode(signature)}`;
};

export interface DecodedJwt {
  header: JwtClaims;
  claims: JwtClaims;
  signed: string;
  signature: Uint8Array<ArrayBuffer>;
}

/** Splits and parses a compact JWS without checking anything; `null` when it is not one. */
export const decodeJwt = (token: string): DecodedJwt | null => {
  const parts = token.split(".");

  if (parts.length !== 3) {
    return null;
  }

  // SAFETY: the length check above leaves exactly three parts.
  const [h, p, s] = parts as [string, string, string];

  try {
    const header: unknown = JSON.parse(base64UrlDecodeString(h));
    const claims: unknown = JSON.parse(base64UrlDecodeString(p));

    if (!isJsonObject(header) || !isJsonObject(claims)) {
      return null;
    }

    return {
      header,
      claims,
      signed: `${h}.${p}`,
      signature: base64UrlDecode(s),
    };
  } catch {
    return null;
  }
};

export interface VerifyOptions {
  /** The issuer's current public keys (its JWKS). */
  keys: Jwk[];
  /** The expected `iss`. */
  issuer: string;
  /** The expected `aud` (one of them when the claim is a list); omit to skip the audience check. */
  audience?: string;
  /** The expected `typ` header, compared case-insensitively; omit to accept any. */
  typ?: string;
  /** Milliseconds since the epoch; defaults to now. */
  now?: number;
  clockSkewSeconds?: number;
}

/**
 * Verifies an ES256 JWT against the issuer's keys and the standard time, issuer and audience claims.
 * Answers the claims, or `null` for anything that does not check out (never throws on bad input).
 */
// oxlint-disable-next-line eslint/complexity -- one verification: its checks run in order and each refuses with `null`
export const verifyJwt = async (
  token: string,
  options: VerifyOptions
): Promise<JwtClaims | null> => {
  const decoded = decodeJwt(token);

  if (!decoded) {
    return null;
  }

  const { header, claims } = decoded;

  if (header.alg !== "ES256" || !isString(header.kid)) {
    return null;
  }

  // RFC 7515 §4.1.11: a token that needs an extension this code does not implement is refused.
  if (header.crit !== undefined) {
    return null;
  }

  if (
    options.typ &&
    (isString(header.typ) ? header.typ : "").toLowerCase() !==
      options.typ.toLowerCase()
  ) {
    return null;
  }

  const key = options.keys.find(
    (k) =>
      k.kid === header.kid &&
      k.kty === "EC" &&
      k.crv === "P-256" &&
      k.x &&
      k.y &&
      (k.use === undefined || k.use === "sig") &&
      (k.alg === undefined || k.alg === "ES256")
  );

  if (!key) {
    return null;
  }

  try {
    const imported = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
      ALG,
      false,
      ["verify"]
    );

    const ok = await crypto.subtle.verify(
      SIGN,
      imported,
      decoded.signature,
      encoder.encode(decoded.signed)
    );

    if (!ok) {
      return null;
    }
  } catch {
    return null;
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? 60;

  if (claims.iss !== options.issuer) {
    return null;
  }

  if (options.audience !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

    if (!audiences.includes(options.audience)) {
      return null;
    }
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
