/**
 * The identity provider's signing keys (docs/SSO.md): an ES256 key made on first use, its private half sealed
 * (`sealSecret`, purpose `oauth-signing-key`) like every secret at rest, and every key a verifier may still need in the
 * key set. Rotating makes a new key and leaves the retired one in the key set for a day, so a token signed just before
 * still verifies. A key whose private half no longer opens (`SESSION_SECRET` rotated) is retired and replaced.
 */
import { desc, eq, isNull } from "drizzle-orm";

import type { Database } from "~/db";
import { oauthSigningKeys } from "~/db/schema";
import type { OauthSigningKey } from "~/db/schema";
import { parseJsonObject, stringOrNull } from "~/lib/guards";
import { openSecret, sealSecret } from "~/lib/secret-box.server";

import { generateSigningKey } from "./jwt";
import type { Jwk, SigningKey } from "./jwt";

/** How long a retired key stays in the key set, so tokens signed just before a rotation still verify. */
const RETIRED_KEY_GRACE_MS = 24 * 60 * 60 * 1000;

const KEY_PURPOSE = "oauth-signing-key";

/** A JWK read back from its column: the object this module wrote, or null when it is not one. */
const parseJwk = (json: string | null): Jwk | null => {
  if (!json) {
    return null;
  }

  const value = parseJsonObject(json);
  const kty = stringOrNull(value.kty);

  if (!kty) {
    return null;
  }

  const jwk: Jwk = { kty };

  for (const name of ["crv", "x", "y", "d", "kid", "alg", "use"] as const) {
    const member = stringOrNull(value[name]);

    if (member) {
      jwk[name] = member;
    }
  }

  return jwk;
};

const fromRow = async (
  env: Env,
  row: OauthSigningKey
): Promise<SigningKey | null> => {
  const privateJwk = parseJwk(
    await openSecret(env, KEY_PURPOSE, row.privateJwk)
  );

  const publicJwk = parseJwk(row.publicJwk);

  return privateJwk && publicJwk
    ? { kid: row.kid, alg: "ES256", privateJwk, publicJwk }
    : null;
};

const newestUnretired = (db: Database) =>
  db.query.oauthSigningKeys.findFirst({
    where: isNull(oauthSigningKeys.retiredAt),
    orderBy: [desc(oauthSigningKeys.createdAt), desc(oauthSigningKeys.kid)],
  });

const makeKey = async (db: Database, env: Env): Promise<SigningKey> => {
  const key = await generateSigningKey();

  await db.insert(oauthSigningKeys).values({
    kid: key.kid,
    alg: key.alg,
    privateJwk: await sealSecret(
      env,
      KEY_PURPOSE,
      JSON.stringify(key.privateJwk)
    ),
    publicJwk: JSON.stringify(key.publicJwk),
  });

  return key;
};

/** The key new tokens are signed with: the newest unretired key, made on first use. */
export const currentSigningKey = async (
  db: Database,
  env: Env,
  now = new Date()
): Promise<SigningKey> => {
  const existing = await newestUnretired(db);

  if (existing) {
    const key = await fromRow(env, existing);

    if (key) {
      return key;
    }

    // Sealed under a secret that is gone: nothing can sign with it, so it leaves the way a rotation does.
    await db
      .update(oauthSigningKeys)
      .set({ retiredAt: now.toISOString() })
      .where(eq(oauthSigningKeys.kid, existing.kid));
  }

  const made = await makeKey(db, env);
  // Two isolates may have made a first key at once; both verify, and the newest row signs from here on.
  const chosen = await newestUnretired(db);
  const key = chosen ? await fromRow(env, chosen) : null;

  return key ?? made;
};

/** What a verifier may see: every unretired key, and those retired less than a day ago. */
export const publicJwks = async (
  db: Database,
  env: Env,
  now = Date.now()
): Promise<Jwk[]> => {
  await currentSigningKey(db, env, new Date(now));

  const rows = await db.query.oauthSigningKeys.findMany({
    orderBy: [desc(oauthSigningKeys.createdAt)],
  });

  return rows
    .filter(
      (row) =>
        !row.retiredAt || Date.parse(row.retiredAt) + RETIRED_KEY_GRACE_MS > now
    )
    .map((row) => parseJwk(row.publicJwk))
    .filter((jwk): jwk is Jwk => jwk !== null);
};

/** Retires every current key and makes a new one; the old ones keep verifying for a day. */
export const rotateSigningKey = async (
  db: Database,
  env: Env,
  now = new Date()
): Promise<SigningKey> => {
  await db
    .update(oauthSigningKeys)
    .set({ retiredAt: now.toISOString() })
    .where(isNull(oauthSigningKeys.retiredAt));

  return currentSigningKey(db, env, now);
};

/** Every key, newest first, for the Applications tab. */
export const listSigningKeys = async (db: Database) => {
  const rows = await db.query.oauthSigningKeys.findMany({
    orderBy: [desc(oauthSigningKeys.createdAt)],
  });

  return rows.map((row) => ({
    kid: row.kid,
    createdAt: row.createdAt,
    retiredAt: row.retiredAt,
  }));
};
