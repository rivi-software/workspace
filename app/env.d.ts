// The Worker's secrets (`wrangler secret put`; .dev.vars locally). `wrangler types` declares them
// only when a .dev.vars file is present, and CI's typecheck runs without one. Keep this list in
// step with .dev.vars.example: `wrangler types` declares the same names with the same type.
// Both the global `Env` and `Cloudflare.Env` extend the generated base, so both are augmented.
interface WorkspaceSecrets {
  // Signs the session cookies (Better Auth's secret), the file links the mail view loads inline, and every sealed
  // value (an undo record, a link's pass, an import's tokens at rest).
  SESSION_SECRET: string;
  // Importing a Microsoft 365 mailbox (README, Microsoft 365 import): the Entra application's client id and secret,
  // and its directory (tenant id; empty: any work account). Without the id and secret the import is off.
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_TENANT_ID: string;
  // Amazon SES (`@rivi-software/workers-mail`, README, Amazon SES): the access key of the IAM user that may send as
  // the mail domain in `SES_REGION` (a var). Empty: mail goes out through the EMAIL binding.
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
}

// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type -- declaration merging with ambient Env for Worker secrets
interface Env extends WorkspaceSecrets {}

declare namespace Cloudflare {
  // oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type -- declaration merging with ambient Env for Worker secrets
  interface Env extends WorkspaceSecrets {}
}
