/** The identity provider's addresses, relative to the console's origin (the issuer). A plain module: the UI reads it too. */
export const SSO_PATHS = {
  discovery: "/.well-known/openid-configuration",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  jwks: "/oauth/jwks",
  userinfo: "/oauth/userinfo",
  logout: "/oauth/logout",
} as const;

const PATHS: ReadonlySet<string> = new Set(Object.values(SSO_PATHS));

/** Whether the Worker answers this path as the identity provider (`handleSsoRequest`), before TanStack Start. */
export const isSsoPath = (pathname: string): boolean => PATHS.has(pathname);
