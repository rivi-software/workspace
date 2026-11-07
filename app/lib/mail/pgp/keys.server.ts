/**
 * OpenPGP keys: each person's own (`pgp_keys`, made here or imported, the private key sealed under SESSION_SECRET) and
 * those of the people they write to (`pgp_peer_keys`). Which key goes with an address is `lookup.server.ts`'s.
 */
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Key, PrivateKey, PublicKey } from "openpgp";

import type { Database } from "~/db";
import { aliases, pgpKeys, pgpPeerKeys, users } from "~/db/schema";
import type { PgpKey, User } from "~/db/schema";
import { errorMessage } from "~/lib/guards";
import { openSecret, sealSecret } from "~/lib/secret-box.server";

import { canonicalAddress } from "../addresses";
import { ownAddresses } from "../threads.server";
import { PGP_CONFIG, keyAddresses, loadOpenPgp } from "./openpgp.server";
import type { OwnKeyView, PeerKeyView } from "./pgp";

const SEAL_PURPOSE = "pgp-private-key";

/** What a person tried with a key, refused in words they can act on: the passphrase, a key that cannot sign, … */
export class PgpError extends Error {
  override name = "PgpError";
}

/** A key's own checks: not revoked, not expired, its self-signatures sound. */
const usable = async (key: Key): Promise<string | null> => {
  try {
    await key.verifyPrimaryKey();

    return null;
  } catch (error) {
    return errorMessage(error);
  }
};

// ---------- the person's own key ----------

export const ownKeyRow = async (
  db: Database,
  userId: string
): Promise<PgpKey | undefined> =>
  await db.query.pgpKeys.findFirst({ where: eq(pgpKeys.userId, userId) });

export const ownKeyView = async (
  db: Database,
  userId: string
): Promise<OwnKeyView | null> => {
  const row = await ownKeyRow(db, userId);

  if (!row) {
    return null;
  }

  const openpgp = await loadOpenPgp();

  const key = await openpgp.readKey({
    armoredKey: row.publicKey,
    config: PGP_CONFIG,
  });

  return {
    fingerprint: row.fingerprint,
    addresses: keyAddresses(key),
    createdAt: row.createdAt,
    publicKey: row.publicKey,
  };
};

const keep = async (
  env: Env,
  db: Database,
  userId: string,
  key: PrivateKey
): Promise<void> => {
  const existing = await ownKeyRow(db, userId);

  if (existing) {
    throw new PgpError(
      "You already have a key. Remove it first to make or import another."
    );
  }

  await db.insert(pgpKeys).values({
    userId,
    fingerprint: key.getFingerprint(),
    publicKey: key.toPublic().armor(),
    privateKeySealed: await sealSecret(env, SEAL_PURPOSE, key.armor()),
    createdAt: new Date().toISOString(),
  });
};

/**
 * A new key for the person, curve25519 in the version 4 format that GnuPG 2.2 and every mail client read, naming their
 * address and each alias under their name. It has no passphrase: the seal is its lock.
 */
export const generateOwnKey = async (
  env: Env,
  db: Database,
  user: User
): Promise<void> => {
  const openpgp = await loadOpenPgp();
  const addresses = [...(await ownAddresses(db, user))];

  const { privateKey } = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: addresses.map((email) => ({ name: user.name, email })),
    format: "object",
    config: PGP_CONFIG,
  });

  await keep(env, db, user.id, privateKey);
};

/**
 * A key the person already has elsewhere (GnuPG's `--export-secret-keys --armor`, Thunderbird's backup), unlocked with
 * its passphrase. It must be usable, sign, decrypt, and name at least one of the person's addresses, or the mail it
 * signs would read as someone else's.
 */
export const importOwnKey = async (
  env: Env,
  db: Database,
  user: User,
  armored: string,
  passphrase: string
): Promise<void> => {
  const openpgp = await loadOpenPgp();
  let key: PrivateKey;

  try {
    key = await openpgp.readPrivateKey({
      armoredKey: armored.trim(),
      config: PGP_CONFIG,
    });
  } catch {
    throw new PgpError(
      "That is not an OpenPGP private key. Paste the whole block, from -----BEGIN PGP PRIVATE KEY BLOCK----- to its END line."
    );
  }

  if (!key.isDecrypted()) {
    try {
      key = await openpgp.decryptKey({
        privateKey: key,
        passphrase,
        config: PGP_CONFIG,
      });
    } catch {
      throw new PgpError("The passphrase does not unlock this key.");
    }
  }

  const problem = await usable(key);

  if (problem) {
    throw new PgpError(`This key cannot be used: ${problem}`);
  }

  try {
    await key.getSigningKey();
    await key.getDecryptionKeys();
  } catch {
    throw new PgpError(
      "This key cannot both sign and decrypt, which mail needs."
    );
  }

  const own = await ownAddresses(db, user);

  if (!keyAddresses(key).some((a) => own.has(a))) {
    throw new PgpError(
      `This key names none of your addresses (${[...own].join(", ")}), so mail signed with it would read as someone else's.`
    );
  }

  await keep(env, db, user.id, key);
};

export const removeOwnKey = async (
  db: Database,
  userId: string
): Promise<void> => {
  await db.delete(pgpKeys).where(eq(pgpKeys.userId, userId));
};

/**
 * The person's private key, unlocked; null when they have none. A key that no longer opens (SESSION_SECRET changed
 * since it was sealed) is a PgpError, which says how to put it back.
 */
export const ownPrivateKey = async (
  env: Env,
  db: Database,
  userId: string
): Promise<PrivateKey | null> => {
  const row = await ownKeyRow(db, userId);

  if (!row) {
    return null;
  }

  const armored = await openSecret(env, SEAL_PURPOSE, row.privateKeySealed);

  if (!armored) {
    throw new PgpError(
      "Your OpenPGP key can no longer be read here (the workspace's secret changed). Remove it under Settings → Mail and import your exported copy."
    );
  }

  const openpgp = await loadOpenPgp();

  return await openpgp.readPrivateKey({
    armoredKey: armored,
    config: PGP_CONFIG,
  });
};

/** The person's private key for another client, locked with a passphrase of theirs (8 characters at least). */
export const exportOwnKey = async (
  env: Env,
  db: Database,
  userId: string,
  passphrase: string
): Promise<string> => {
  if (passphrase.length < 8) {
    throw new PgpError(
      "Choose a passphrase of at least 8 characters to lock the exported key."
    );
  }

  const key = await ownPrivateKey(env, db, userId);

  if (!key) {
    throw new PgpError("You have no key to export.");
  }

  const openpgp = await loadOpenPgp();

  const locked = await openpgp.encryptKey({
    privateKey: key,
    passphrase,
    config: PGP_CONFIG,
  });

  return locked.armor();
};

/**
 * The key of the mailbox an address on this workspace is delivered to (its owner's address, an alias, a `+tag`),
 * with whether its owner is active; undefined when the address is no mailbox's or its owner has no key.
 */
export const workspaceKeyRow = async (
  db: Database,
  address: string
): Promise<(PgpKey & { active: boolean }) | undefined> => {
  const canonical = canonicalAddress(address);

  const [row] = await db
    .select({ key: pgpKeys, active: users.active })
    .from(pgpKeys)
    .innerJoin(users, eq(users.id, pgpKeys.userId))
    .where(
      or(
        eq(users.email, canonical),
        sql`${users.id} = (select ${aliases.userId} from ${aliases} where ${aliases.address} = ${canonical})`
      )
    )
    .limit(1);

  return row ? { ...row.key, active: row.active } : undefined;
};

// ---------- the keys of others ----------

const peerView = (row: typeof pgpPeerKeys.$inferSelect): PeerKeyView => ({
  address: row.address,
  fingerprint: row.fingerprint,
  source: row.source,
  preferEncrypt: row.preferEncrypt,
  seenAt: row.seenAt,
});

export const listPeerKeys = async (
  db: Database,
  userId: string
): Promise<PeerKeyView[]> => {
  const rows = await db.query.pgpPeerKeys.findMany({
    where: eq(pgpPeerKeys.userId, userId),
    orderBy: [asc(pgpPeerKeys.address)],
  });

  return rows.map(peerView);
};

export const peerKeyRow = async (
  db: Database,
  userId: string,
  address: string
) =>
  await db.query.pgpPeerKeys.findFirst({
    where: and(
      eq(pgpPeerKeys.userId, userId),
      eq(pgpPeerKeys.address, address.toLowerCase())
    ),
  });

/**
 * Keep a correspondent's key for an address. A key the person imported is replaced only by another they import; one
 * that arrived (Autocrypt) or was looked up (WKD) is replaced by what is vouched for later, never by older mail.
 */
export const rememberPeerKey = async (
  db: Database,
  userId: string,
  found: {
    address: string;
    key: PublicKey;
    source: PeerKeyView["source"];
    preferEncrypt?: boolean;
    seenAt: string;
  }
): Promise<void> => {
  const address = found.address.toLowerCase();
  const existing = await peerKeyRow(db, userId, address);

  if (existing) {
    const outranked =
      existing.source === "imported" && found.source !== "imported";

    const older = found.source !== "imported" && found.seenAt < existing.seenAt;

    if (outranked || older) {
      return;
    }
  }

  const values = {
    fingerprint: found.key.getFingerprint(),
    publicKey: found.key.armor(),
    source: found.source,
    preferEncrypt: found.preferEncrypt ?? false,
    seenAt: found.seenAt,
  };

  await db
    .insert(pgpPeerKeys)
    .values({ userId, address, ...values })
    .onConflictDoUpdate({
      target: [pgpPeerKeys.userId, pgpPeerKeys.address],
      set: values,
    });
};

/**
 * The public keys someone gave the person (an `.asc` file, a block pasted from their site), each kept for every
 * address it names. A private key is read for its public half; one that is expired or revoked is refused.
 */
export const importPeerKeys = async (
  db: Database,
  userId: string,
  armored: string,
  now = new Date()
): Promise<string[]> => {
  const openpgp = await loadOpenPgp();
  let keys: Key[];

  try {
    keys = await openpgp.readKeys({
      armoredKeys: armored.trim(),
      config: PGP_CONFIG,
    });
  } catch {
    throw new PgpError(
      "That is not an OpenPGP public key. Paste the whole block, from -----BEGIN PGP PUBLIC KEY BLOCK----- to its END line."
    );
  }

  const kept: string[] = [];

  for (const key of keys) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a block holds one key, or a few at most
    const problem = await usable(key);

    if (problem) {
      throw new PgpError(
        `The key ${key.getKeyID().toHex().toUpperCase()} cannot be used: ${problem}`
      );
    }

    for (const address of keyAddresses(key)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above
      await rememberPeerKey(db, userId, {
        address,
        key: key.toPublic(),
        source: "imported",
        seenAt: now.toISOString(),
      });
      kept.push(address);
    }
  }

  if (!kept.length) {
    throw new PgpError(
      "The key names no address, so there is nobody to keep it for."
    );
  }

  return kept;
};

export const removePeerKey = async (
  db: Database,
  userId: string,
  address: string
): Promise<void> => {
  await db
    .delete(pgpPeerKeys)
    .where(
      and(
        eq(pgpPeerKeys.userId, userId),
        eq(pgpPeerKeys.address, address.toLowerCase())
      )
    );
};
