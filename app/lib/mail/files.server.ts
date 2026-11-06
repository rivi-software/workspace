/**
 * Links to a message's files that need no cookie: the viewer shows inline images from a sandboxed iframe, whose
 * requests carry no session, and a download link may be opened from anywhere. The link names the attachment and an
 * expiry, signed with SESSION_SECRET; the handler (`app/routes/api/files.$id.ts`) checks the signature and expiry
 * and nothing else, so a link is as private as the person it was shown to.
 */

const DEFAULT_TTL_SECONDS = 60 * 60 * 6;

const hmac = async (secret: string, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
};

export const signFileUrl = async (
  env: Env,
  attachmentId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<string> => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmac(env.SESSION_SECRET, `${attachmentId}.${exp}`);

  return `/api/files/${attachmentId}?exp=${exp}&sig=${sig}`;
};

export const verifyFileSignature = async (
  env: Env,
  attachmentId: string,
  exp: string | null,
  sig: string | null
): Promise<boolean> => {
  if (!exp || !sig || !/^\d+$/u.test(exp)) {
    return false;
  }

  if (Number(exp) < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = await hmac(env.SESSION_SECRET, `${attachmentId}.${exp}`);

  if (expected.length !== sig.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < expected.length; i += 1) {
    // oxlint-disable-next-line eslint/no-bitwise -- a constant-time comparison ORs the XOR of every character pair, with no branch that depends on the data
    diff |= (expected.codePointAt(i) ?? 0) ^ (sig.codePointAt(i) ?? 0);
  }

  return diff === 0;
};
