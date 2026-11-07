/**
 * The OpenPGP Web Key Directory (draft-koch-openpgp-webkey-service): a domain publishes its people's keys at a path
 * made from the hash of the address's local part. The Worker serves its own people's keys (`serveWkd`, at the
 * advanced and the direct path both) and looks a correspondent's key up the same way (`lookupWkd`).
 */
import type { PublicKey } from "openpgp";

import { createDb } from "~/db";

import { workspaceKeyRow } from "./keys.server";
import { PGP_CONFIG, keyAddresses, loadOpenPgp } from "./openpgp.server";

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/**
 * Bytes in z-base-32, five bits a character, as WKD names its files. `value` holds the bits not yet written (fewer
 * than 13), so plain arithmetic does what shifts would.
 */
const zbase32 = (bytes: Uint8Array): string => {
  let out = "";
  let bits = 0;
  let value = 0;

  for (const byte of bytes) {
    value = value * 256 + byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      const rest = 2 ** bits;
      out += ZBASE32[Math.floor(value / rest)];
      value %= rest;
    }
  }

  if (bits > 0) {
    out += ZBASE32[value * 2 ** (5 - bits)];
  }

  return out;
};

/** The WKD name of a local part: its SHA-1, ASCII letters lower-cased first, in z-base-32 (32 characters). */
export const wkdHash = async (local: string): Promise<string> => {
  const lowered = local.replaceAll(/[A-Z]/gu, (c) => c.toLowerCase());

  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(lowered)
  );

  return zbase32(new Uint8Array(digest));
};

/** The two places a domain may publish an address's key: the advanced method on `openpgpkey.`, then the direct one. */
export const wkdUrls = async (address: string): Promise<string[]> => {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  const path = `hu/${await wkdHash(local)}?l=${encodeURIComponent(local)}`;

  return [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/${path}`,
    `https://${domain}/.well-known/openpgpkey/${path}`,
  ];
};

/** No key behind an address is remembered this long, so mail from it does not ask its domain every time. */
const MISS_SECONDS = 24 * 60 * 60;

/** A key file larger than this is no key a domain would publish for one address. */
const MAX_KEY_BYTES = 256 * 1024;

const WKD_TIMEOUT_MS = 4000;

const missKey = (address: string) => `pgp:wkd-miss:${address}`;

/** The bytes a WKD URL answers, or null for no answer, a miss, or more than a key. */
const fetchKeyFile = async (
  url: string,
  fetcher: typeof fetch
): Promise<Uint8Array | null> => {
  try {
    const res = await fetcher(url, {
      signal: AbortSignal.timeout(WKD_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!res.ok) {
      return null;
    }

    const body = new Uint8Array(await res.arrayBuffer());

    return body.length > 0 && body.length <= MAX_KEY_BYTES ? body : null;
  } catch {
    // An unknown host (no `openpgpkey.` subdomain), a timeout, a refused connection: the next place is tried.
    return null;
  }
};

/**
 * The key the address's domain publishes for it over WKD: the first of the file's keys that names the address and
 * can still encrypt. A miss is remembered in KV for a day; a find is the caller's to keep (`pgp_peer_keys`).
 */
export const lookupWkd = async (
  env: Env,
  address: string,
  fetcher: typeof fetch = fetch
): Promise<PublicKey | null> => {
  const wanted = address.toLowerCase();

  if (await env.KV.get(missKey(wanted))) {
    return null;
  }

  const openpgp = await loadOpenPgp();

  for (const url of await wkdUrls(wanted)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the direct method is asked only when the advanced one has no key
    const file = await fetchKeyFile(url, fetcher);

    if (!file) {
      continue;
    }

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above: one place at a time
      const keys = await openpgp.readKeys({
        binaryKeys: file,
        config: PGP_CONFIG,
      });

      for (const key of keys) {
        if (!keyAddresses(key).includes(wanted)) {
          continue;
        }

        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- a file holds one key, or a few at most
          await key.getEncryptionKey();

          return key.toPublic();
        } catch {
          // Expired, revoked, or no key to encrypt with: the next one, if any.
        }
      }
    } catch {
      // Not OpenPGP: as if nothing were published there.
    }
  }

  await env.KV.put(missKey(wanted), "1", { expirationTtl: MISS_SECONDS });

  return null;
};

const WKD_PREFIX = "/.well-known/openpgpkey/";

/** Whether the Worker answers this path itself: a WKD key file or policy, advanced or direct. */
export const isWkdPath = (pathname: string): boolean =>
  pathname.startsWith(WKD_PREFIX);

const wkdHeaders = {
  // Clients in browsers (Mailvelope, a webmail) read keys across origins (§3.1).
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
};

const notFound = () =>
  new Response("Not found", { status: 404, headers: wkdHeaders });

/**
 * The Worker's own Web Key Directory, for `MAIL_DOMAIN` alone: `policy` (empty, as the draft allows) and `hu/<hash>`,
 * answered with the key of the active person or alias the `l` parameter names, when that key names the address. A
 * request without `l` is not answered: finding the address from its hash alone means hashing every mailbox.
 */
export const serveWkd = async (
  request: Request,
  env: Env
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...wkdHeaders, Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const rest = url.pathname.slice(WKD_PREFIX.length).split("/");
  const domain = env.MAIL_DOMAIN.toLowerCase();

  // The advanced method names the domain in its path; the direct method is the domain's own.
  if (rest[0]?.toLowerCase() === domain) {
    rest.shift();
  }

  if (rest.length === 1 && rest[0] === "policy") {
    return new Response(request.method === "HEAD" ? null : "", {
      headers: { ...wkdHeaders, "Content-Type": "text/plain" },
    });
  }

  const local = url.searchParams.get("l");

  if (rest.length !== 2 || rest[0] !== "hu" || !local || local.includes("@")) {
    return notFound();
  }

  if ((await wkdHash(local)) !== rest[1]) {
    return notFound();
  }

  const address = `${local.toLowerCase()}@${domain}`;
  const row = await workspaceKeyRow(createDb(env.DB), address);

  if (!row?.active) {
    return notFound();
  }

  const openpgp = await loadOpenPgp();

  const key = await openpgp.readKey({
    armoredKey: row.publicKey,
    config: PGP_CONFIG,
  });

  if (!keyAddresses(key).includes(address)) {
    return notFound();
  }

  return new Response(
    request.method === "HEAD" ? null : new Uint8Array(key.write()),
    {
      headers: { ...wkdHeaders, "Content-Type": "application/octet-stream" },
    }
  );
};
