/**
 * OpenPGP.js, loaded on first use rather than with the Worker: it is a large module, and only mail with OpenPGP in it,
 * a key being made or read, or a WKD request needs it (as Better Auth is, `loadBetterAuth`).
 */
import type * as OpenPgp from "openpgp";
import type { Key, PartialConfig } from "openpgp";

let loading: Promise<typeof OpenPgp> | null = null;

export const loadOpenPgp = async (): Promise<typeof OpenPgp> => {
  loading ??= import("openpgp");

  try {
    return await loading;
  } catch (error) {
    // A failed load is tried again next time, not kept.
    loading = null;
    throw error;
  }
};

/**
 * The limits every call runs under. A Worker has 128 MB: a compressed message may not open into more than a message
 * can carry (OpenPGP.js allows any size), and an imported key's Argon2 may not ask for more memory than the Worker has.
 */
export const PGP_CONFIG: PartialConfig = {
  maxDecompressedMessageSize: 48 * 1024 * 1024,
  // 2^16 KiB, 64 MiB: what OpenPGP.js itself uses for a key it protects with Argon2.
  maxArgon2MemoryExponent: 16,
};

/** The addresses a key's user IDs name, lower-cased, each once. */
export const keyAddresses = (key: Key): string[] => [
  ...new Set(
    key.users
      .map((u) => u.userID?.email.toLowerCase() ?? "")
      .filter((email) => email.includes("@"))
  ),
];
