const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** URL-safe random id. Uses crypto.getRandomValues (never Math.random). */
export const newId = (prefix = ""): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";

  for (const b of bytes) {
    out += ALPHABET[b % ALPHABET.length];
  }

  return prefix ? `${prefix}_${out}` : out;
};

export const nowIso = (): string => new Date().toISOString();
