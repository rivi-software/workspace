/** Whether Duo confirms password sign-ins: its three secrets are all set. A plain module, so `auth.server.ts` reads it too. */
export const duoEnabled = (
  env: Pick<Env, "DUO_CLIENT_ID" | "DUO_CLIENT_SECRET" | "DUO_API_HOST">
): boolean =>
  Boolean(env.DUO_CLIENT_ID && env.DUO_CLIENT_SECRET && env.DUO_API_HOST);
