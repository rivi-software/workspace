// Renders seed/seed.sql with a real PBKDF2 password hash (the same algorithm as app/lib/auth.server.ts, which Better
// Auth checks passwords with) and the timestamps Better Auth's tables need.
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const password = process.env.SEED_PASSWORD || "password";
const ITER = 100_000;
const salt = crypto.getRandomValues(new Uint8Array(16));

const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveBits"]
);

const bits = new Uint8Array(
  await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER },
    key,
    256
  )
);

const hex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const hash = `pbkdf2$${ITER}$${hex(salt)}$${hex(bits)}`;

const sql = readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf-8")
  .replaceAll("__PASSWORD_HASH__", hash)
  .replaceAll("__NOW_MS__", String(Date.now()));

writeFileSync(new URL("../seed/seed.generated.sql", import.meta.url), sql);

console.log("seed/seed.generated.sql written");
