/**
 * Which key goes with an address, for one mailbox: a colleague's own key for an address of this workspace (never
 * anything else for it), else the key the mailbox keeps for that correspondent, else the one their domain publishes
 * over WKD, which is then kept.
 */
import type { PublicKey } from "openpgp";

import type { Database } from "~/db";
import type { User } from "~/db/schema";

import { domainOf } from "../addresses";
import { peerKeyRow, rememberPeerKey, workspaceKeyRow } from "./keys.server";
import { PGP_CONFIG, loadOpenPgp } from "./openpgp.server";
import type { KeySource } from "./pgp";
import { lookupWkd } from "./wkd.server";

export interface FoundKey {
  key: PublicKey;
  fingerprint: string;
  source: KeySource;
}

export interface LookupOptions {
  /** Ask the address's domain over WKD when nothing is kept for it (mail that arrives signed, a send). */
  wkd: boolean;
  /** The tests lay a WKD of their own over it; nothing else passes one. */
  fetch?: typeof fetch;
  now?: Date;
}

const readPublic = async (armored: string): Promise<PublicKey> => {
  const openpgp = await loadOpenPgp();

  return await openpgp.readKey({ armoredKey: armored, config: PGP_CONFIG });
};

/** Ask WKD for the address's key and keep what it answers. */
const fromWkd = async (
  env: Env,
  db: Database,
  owner: Pick<User, "id">,
  address: string,
  options: LookupOptions
): Promise<FoundKey | null> => {
  const key = await lookupWkd(env, address, options.fetch);

  if (!key) {
    return null;
  }

  await rememberPeerKey(db, owner.id, {
    address,
    key,
    source: "wkd",
    seenAt: (options.now ?? new Date()).toISOString(),
  });

  return { key, fingerprint: key.getFingerprint(), source: "wkd" };
};

export const keyFor = async (
  env: Env,
  db: Database,
  owner: Pick<User, "id">,
  address: string,
  options: LookupOptions
): Promise<FoundKey | null> => {
  const wanted = address.toLowerCase();

  if (domainOf(wanted) === env.MAIL_DOMAIN.toLowerCase()) {
    const row = await workspaceKeyRow(db, wanted);

    return row
      ? {
          key: await readPublic(row.publicKey),
          fingerprint: row.fingerprint,
          source: "workspace",
        }
      : null;
  }

  const peer = await peerKeyRow(db, owner.id, wanted);

  if (peer) {
    return {
      key: await readPublic(peer.publicKey),
      fingerprint: peer.fingerprint,
      source: peer.source,
    };
  }

  return options.wkd ? await fromWkd(env, db, owner, wanted, options) : null;
};

const canEncrypt = async (key: PublicKey, now: Date): Promise<boolean> => {
  try {
    await key.getEncryptionKey(undefined, now);

    return true;
  } catch {
    return false;
  }
};

/**
 * A key that can encrypt for one address. A kept key that no longer can (expired, revoked) is looked up again over
 * WKD unless the person imported it themselves.
 */
const encryptionKeyFor = async (
  env: Env,
  db: Database,
  owner: Pick<User, "id">,
  address: string,
  options: LookupOptions & { now: Date }
): Promise<PublicKey | null> => {
  const found = await keyFor(env, db, owner, address, options);

  if (found && (await canEncrypt(found.key, options.now))) {
    return found.key;
  }

  if (found?.source !== "autocrypt" && found?.source !== "wkd") {
    return null;
  }

  const fresh = await fromWkd(env, db, owner, address, options);

  return fresh && (await canEncrypt(fresh.key, options.now)) ? fresh.key : null;
};

/** A key to encrypt to for every address, or the addresses that have none. */
export const recipientKeys = async (
  env: Env,
  db: Database,
  owner: Pick<User, "id">,
  addresses: string[],
  options: Omit<LookupOptions, "wkd"> = {}
): Promise<{ keys: PublicKey[]; missing: string[] }> => {
  const now = options.now ?? new Date();
  const keys: PublicKey[] = [];
  const missing: string[] = [];

  for (const address of new Set(addresses.map((a) => a.toLowerCase()))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a message has a few recipients; each may ask its domain, one at a time
    const key = await encryptionKeyFor(env, db, owner, address, {
      ...options,
      wkd: true,
      now,
    });

    if (key) {
      keys.push(key);
    } else {
      missing.push(address);
    }
  }

  return { keys, missing };
};
