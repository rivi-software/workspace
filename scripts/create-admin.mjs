// Creates (or resets) an admin mailbox in the D1 database. Use it to bootstrap production and to recover a locked-out admin.
//
//   pnpm admin:create --remote --email you@example.com --name "Your Name"          # prints a generated password once
//   pnpm admin:create --local  --email dev@example.com --name Dev --password "…"   # explicit password (12+ chars)
//
// An existing account with that address is updated: the password is replaced, every session and reset link of theirs
// ends (as `revoke` in app/lib/auth.server.ts does for a new password), the account becomes an active admin, and its
// authenticator app is reset (a lost phone no longer locks an admin out).
import { spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";

const args = process.argv.slice(2);

const opt = (name) => {
  const i = args.indexOf(`--${name}`);

  return i === -1 ? undefined : args[i + 1];
};

const remote = args.includes("--remote");
const local = args.includes("--local");
const email = (opt("email") ?? "").trim().toLowerCase();
const name = (opt("name") ?? "").trim();
let password = opt("password");

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (remote === local) {
  fail("Pass exactly one of --remote or --local.");
}

if (!/^[^\s@+]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
  fail("Pass a valid --email (on the mail domain, without a +tag).");
}

if (!name) {
  fail("Pass --name.");
}

if (password !== undefined && password.length < 12) {
  fail("The password must be at least 12 characters.");
}

const generatePassword = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));

  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};

if (password === undefined) {
  password = generatePassword();
}

// The same PBKDF2-SHA256 as app/lib/auth.server.ts, which Better Auth checks the password with.
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
const id = `usr_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
const accountId = `acc_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
const now = Date.now();
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
const whose = `(SELECT id FROM users WHERE email = ${q(email)})`;

// Several statements, separated by semicolons, which `wrangler d1 execute --command` runs in turn.
const sql = [
  `INSERT INTO users (id, email, name, role, active, updated_at) VALUES (${q(id)}, ${q(email)}, ${q(name)}, 'admin', 1, ${now}) ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = 'admin', active = 1, two_factor_enabled = 0, updated_at = excluded.updated_at`,
  `DELETE FROM accounts WHERE provider_id = 'credential' AND user_id = ${whose}`,
  `INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT ${q(accountId)}, id, 'credential', id, ${q(hash)}, ${now}, ${now} FROM users WHERE email = ${q(email)}`,
  `DELETE FROM sessions WHERE user_id = ${whose}`,
  `DELETE FROM recovery_tokens WHERE purpose = 'reset-password' AND user_id = ${whose}`,
  `DELETE FROM two_factors WHERE user_id = ${whose}`,
].join("; ");

const res = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "DB",
    remote ? "--remote" : "--local",
    "--command",
    sql,
  ],
  { stdio: ["ignore", "pipe", "inherit"], encoding: "utf-8" }
);

if (res.status !== 0) {
  fail(`wrangler d1 execute failed (exit ${res.status})`);
}

console.log(`Admin ready on the ${remote ? "remote" : "local"} database.`);

console.log(`  email:    ${email}`);

console.log(`  password: ${password}`);

console.log("Sign in and change the password under Settings → Account.");
