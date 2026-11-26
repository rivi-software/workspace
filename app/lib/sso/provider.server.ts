/**
 * The workspace as an OpenID Connect identity provider (single sign-on, docs/SSO.md): the authorization code flow with
 * PKCE for the applications registered under Settings → Applications. A person signs in here (the password, then Duo
 * or the authenticator app, or a passkey) and the application gets an ID token saying who and how (`amr`). The
 * handlers take plain Requests, so `workers/worker.ts` serves them before TanStack Start and the tests call them
 * through `exports.default.fetch`.
 */
import { eq, lt } from "drizzle-orm";

import type { Database } from "~/db";
import { oauthCodes, users } from "~/db/schema";
import type { User } from "~/db/schema";
import { codeChallenge, randomToken, sha256Hex } from "~/lib/crypto";
import { numberOr, stringList, stringOrNull } from "~/lib/guards";

import { endCurrentSession, getSessionIdentity } from "../auth.server";
import {
  clientAccessFor,
  findClient,
  normaliseUri,
  postLogoutUriAllowed,
  redirectUriAllowed,
  verifyClientSecret,
} from "./clients.server";
import { decodeJwt, signJwt, verifyJwt } from "./jwt";
import type { JwtClaims } from "./jwt";
import { currentSigningKey, publicJwks } from "./keys.server";
import { SSO_PATHS } from "./paths";

/** A code is redeemed within two minutes (RFC 6749 recommends at most ten). */
const CODE_TTL_SECONDS = 120;

/** ID and access tokens live an hour; applications keep a session of their own. */
const TOKEN_TTL_SECONDS = 60 * 60;

const SCOPES = ["openid", "email", "profile"];

/** A sign-in this recent satisfies `prompt=login` and `max_age`, so a fresh sign-in is not asked for twice. */
const REAUTH_GRACE_SECONDS = 60;

/** The issuer identifier: the console's origin, as every token's `iss` and the discovery document name it. */
export const issuerOf = (env: Pick<Env, "APP_URL">): string =>
  env.APP_URL.replace(/\/+$/u, "");

export const discoveryDocument = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}${SSO_PATHS.authorize}`,
  token_endpoint: `${issuer}${SSO_PATHS.token}`,
  jwks_uri: `${issuer}${SSO_PATHS.jwks}`,
  userinfo_endpoint: `${issuer}${SSO_PATHS.userinfo}`,
  end_session_endpoint: `${issuer}${SSO_PATHS.logout}`,
  scopes_supported: SCOPES,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["ES256"],
  token_endpoint_auth_methods_supported: [
    "client_secret_basic",
    "client_secret_post",
  ],
  code_challenge_methods_supported: ["S256"],
  claims_supported: [
    "sub",
    "iss",
    "aud",
    "exp",
    "iat",
    "auth_time",
    "nonce",
    "sid",
    "amr",
    "role",
    "email",
    "email_verified",
    "name",
  ],
  claims_parameter_supported: false,
  request_parameter_supported: false,
  request_uri_parameter_supported: false,
  authorization_response_iss_parameter_supported: true,
});

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** The discovery document and the key set may be cached a little, and read from any origin (a browser-based client). */
const PUBLIC = {
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
};

const json = (
  body: JwtClaims,
  status = 200,
  headers: Record<string, string> = NO_STORE
): Response => Response.json(body, { status, headers });

const oauthError = (
  error: string,
  description: string,
  status = 400
): Response => json({ error, error_description: description }, status);

const redirectTo = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers({ Location: location, ...NO_STORE });

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
};

const methodNotAllowed = (allow: string) =>
  new Response("method not allowed", {
    status: 405,
    headers: { Allow: allow },
  });

const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (c) => `&#${c.codePointAt(0) ?? 0};`);

/** An authorization request that cannot be answered through its redirect URI (RFC 6749 §4.1.2.1) ends here. */
const errorPage = (
  env: Env,
  status: number,
  title: string,
  detail: string
): Response => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(env.APP_NAME)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 Inter,system-ui,sans-serif;background:#0f1113;color:#e6e7e8}main{max-width:28rem;padding:2rem}h1{font-size:1.125rem;margin:0 0 .5rem}p{margin:0;color:#9ea2a7}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
};

/** A code's `amr_json` as the list it was written from. */
const parseAmr = (text: string): string[] => {
  try {
    return stringList(JSON.parse(text));
  } catch {
    return [];
  }
};

/** The claims every ID token and userinfo answer carry about a person. */
const profileClaims = (user: User) => ({
  email: user.email,
  // The address is a mailbox on the workspace's own domain.
  email_verified: true,
  name: user.name,
});

/** The form fields of a POST as search params; files and repeated names are not part of this protocol. */
const formParams = async (request: Request): Promise<URLSearchParams> => {
  const params = new URLSearchParams();

  for (const [name, value] of await request.formData()) {
    const text = stringOrNull(value);

    if (text !== null) {
      params.set(name, text);
    }
  }

  return params;
};

const requestParams = (request: Request): Promise<URLSearchParams> =>
  request.method === "POST"
    ? formParams(request)
    : Promise.resolve(new URL(request.url).searchParams);

// ---------- authorization endpoint ----------

/** Why an authorization request goes back to the application, as RFC 6749 §4.1.2.1 names it. */
interface Refusal {
  error: string;
  description: string;
}

/** What the request asks that the provider cannot give, checked before anyone signs in; null when it may go on. */
const refusalOf = (
  params: URLSearchParams,
  pkceRequired: boolean
): Refusal | null => {
  if (params.get("response_type") !== "code") {
    return {
      error: "unsupported_response_type",
      description: "Only response_type=code is supported.",
    };
  }

  const responseMode = params.get("response_mode");

  if (responseMode && responseMode !== "query") {
    return {
      error: "invalid_request",
      description: "Only response_mode=query is supported.",
    };
  }

  const requested = (params.get("scope") ?? "").split(/\s+/u);

  if (!requested.includes("openid")) {
    return {
      error: "invalid_scope",
      description: "The scope must include openid.",
    };
  }

  const challenge = params.get("code_challenge");

  if (!challenge) {
    return pkceRequired
      ? {
          error: "invalid_request",
          description: "A PKCE code_challenge is required.",
        }
      : null;
  }

  if ((params.get("code_challenge_method") ?? "plain") !== "S256") {
    return {
      error: "invalid_request",
      description: "code_challenge_method must be S256.",
    };
  }

  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)) {
    return {
      error: "invalid_request",
      description: "code_challenge is not a base64url SHA-256 digest.",
    };
  }

  return null;
};

/**
 * Whether the session's sign-in is older than the application accepts: `prompt=login`, or a `max_age` it has
 * outlived. A sign-in under a minute old satisfies either, so nobody is asked twice.
 */
const signInTooOld = (
  params: URLSearchParams,
  prompt: string[],
  authTime: number,
  now: number
): boolean => {
  const maxAgeText = params.get("max_age") ?? "";
  const maxAge = /^\d+$/u.test(maxAgeText) ? Number(maxAgeText) : null;
  const age = Math.floor(now / 1000) - authTime;

  return (
    (prompt.includes("login") && age > REAUTH_GRACE_SECONDS) ||
    (maxAge !== null && age > Math.max(maxAge, REAUTH_GRACE_SECONDS))
  );
};

// oxlint-disable-next-line eslint/complexity -- one authorization request: the client, its redirect URI, the request's own checks, the person, their access, then the code
const authorize = async (
  request: Request,
  env: Env,
  db: Database,
  now: number
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed("GET, POST");
  }

  const params = await requestParams(request);
  const clientId = params.get("client_id") ?? "";
  const client = await findClient(db, clientId);

  if (!client?.active) {
    return errorPage(
      env,
      400,
      "Unknown application",
      `No active application is registered with the client id "${clientId}". An admin registers applications under Settings → Applications.`
    );
  }

  const redirectUri = normaliseUri(params.get("redirect_uri"));

  if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
    return errorPage(
      env,
      400,
      "Redirect URI not registered",
      `${client.name} asked to send you to ${params.get("redirect_uri") ?? "nowhere"}, which is not one of its registered redirect URIs.`
    );
  }

  const state = params.get("state");
  const issuer = issuerOf(env);

  const back = (error: string, description: string) => {
    const location = new URL(redirectUri);
    location.searchParams.set("error", error);
    location.searchParams.set("error_description", description);

    if (state) {
      location.searchParams.set("state", state);
    }

    location.searchParams.set("iss", issuer);

    return redirectTo(location.href);
  };

  const refusal = refusalOf(params, client.pkceRequired);

  if (refusal) {
    return back(refusal.error, refusal.description);
  }

  const prompt = (params.get("prompt") ?? "").split(/\s+/u).filter(Boolean);
  const identity = await getSessionIdentity(request, env, db);

  if (!identity) {
    if (prompt.includes("none")) {
      return back("login_required", "Nobody is signed in.");
    }

    // Sign in first, then come back to this very request (as a GET).
    const next = `${SSO_PATHS.authorize}?${params.toString()}`;

    return redirectTo(`/login?${new URLSearchParams({ next }).toString()}`);
  }

  // A step-up for the application: sign in again, then come back without the prompt, which the fresh sign-in has
  // answered.
  if (signInTooOld(params, prompt, identity.authTime, now)) {
    if (prompt.includes("none")) {
      return back("login_required", "The person must sign in again.");
    }

    const again = new URLSearchParams(params);
    again.delete("prompt");
    const next = `${SSO_PATHS.authorize}?${again.toString()}`;

    return redirectTo(
      `/login?${new URLSearchParams({ next, reauth: "1" }).toString()}`
    );
  }

  const access = await clientAccessFor(db, client, identity.user.id);

  if (!access.allowed) {
    return back(
      "access_denied",
      `${identity.user.email} is not on the list of people who may sign in to ${client.name}.`
    );
  }

  const requested = (params.get("scope") ?? "").split(/\s+/u);
  const scope = SCOPES.filter((s) => requested.includes(s));
  const code = randomToken(32);

  await db.insert(oauthCodes).values({
    codeHash: await sha256Hex(code),
    clientId: client.id,
    userId: identity.user.id,
    redirectUri,
    scope: scope.join(" "),
    nonce: params.get("nonce"),
    codeChallenge: params.get("code_challenge"),
    sid: identity.sid,
    authTime: identity.authTime,
    amrJson: JSON.stringify(identity.amr),
    role: access.role,
    expiresAt: new Date(now + CODE_TTL_SECONDS * 1000).toISOString(),
  });

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);

  if (state) {
    location.searchParams.set("state", state);
  }

  location.searchParams.set("iss", issuer);

  return redirectTo(location.href);
};

// ---------- token endpoint ----------

/** `client_secret_basic` (the Authorization header) or `client_secret_post` (the form). */
const clientCredentials = (
  request: Request,
  form: URLSearchParams
): { id: string; secret: string } | null => {
  const header = request.headers.get("authorization");

  if (header?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(header.slice(6).trim());
      const colon = decoded.indexOf(":");

      if (colon === -1) {
        return null;
      }

      return {
        id: decodeURIComponent(decoded.slice(0, colon)),
        secret: decodeURIComponent(decoded.slice(colon + 1)),
      };
    } catch {
      return null;
    }
  }

  const id = form.get("client_id");
  const secret = form.get("client_secret");

  return id && secret ? { id, secret } : null;
};

/** Whether the token request's verifier answers the code's PKCE challenge (a code without one needs none). */
const pkceAnswered = async (
  challenge: string | null,
  verifier: string
): Promise<boolean> =>
  !challenge ||
  (/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) &&
    (await codeChallenge(verifier)) === challenge);

// oxlint-disable-next-line eslint/complexity -- one token request: the client, the grant, the code and what it must repeat, the person, then the tokens
const token = async (
  request: Request,
  env: Env,
  db: Database,
  now: number
): Promise<Response> => {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  if (
    !(request.headers.get("content-type") ?? "").includes(
      "application/x-www-form-urlencoded"
    )
  ) {
    return oauthError(
      "invalid_request",
      "Send the request as application/x-www-form-urlencoded."
    );
  }

  const form = await formParams(request);

  const invalidClient = () =>
    json(
      {
        error: "invalid_client",
        error_description: "Unknown client or wrong secret.",
      },
      401,
      { ...NO_STORE, "WWW-Authenticate": `Basic realm="${env.APP_NAME}"` }
    );

  const credentials = clientCredentials(request, form);

  if (!credentials) {
    return invalidClient();
  }

  const client = await findClient(db, credentials.id);

  if (
    !client?.active ||
    !(await verifyClientSecret(client, credentials.secret))
  ) {
    return invalidClient();
  }

  if (form.get("grant_type") !== "authorization_code") {
    return oauthError(
      "unsupported_grant_type",
      "Only grant_type=authorization_code is supported."
    );
  }

  const code = form.get("code") ?? "";

  if (!code) {
    return oauthError("invalid_request", "The code is missing.");
  }

  const nowIso = new Date(now).toISOString();
  // Expired codes go when the next one is redeemed, so the table never grows past the codes of the last minutes.
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, nowIso));

  // Deleting is what makes a code single use: a second redemption finds nothing.
  const [issued] = await db
    .delete(oauthCodes)
    .where(eq(oauthCodes.codeHash, await sha256Hex(code)))
    .returning();

  if (!issued || issued.clientId !== client.id || issued.expiresAt < nowIso) {
    return oauthError("invalid_grant", "The code is unknown, used or expired.");
  }

  if (normaliseUri(form.get("redirect_uri")) !== issued.redirectUri) {
    return oauthError(
      "invalid_grant",
      "redirect_uri differs from the authorization request."
    );
  }

  if (
    !(await pkceAnswered(issued.codeChallenge, form.get("code_verifier") ?? ""))
  ) {
    return oauthError("invalid_grant", "PKCE verification failed.");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, issued.userId),
  });

  if (!user?.active) {
    return oauthError("invalid_grant", "This person can no longer sign in.");
  }

  const key = await currentSigningKey(db, env, new Date(now));
  const issuer = issuerOf(env);
  const iat = Math.floor(now / 1000);
  const session = issued.sid ? { sid: issued.sid } : {};
  const amr = parseAmr(issued.amrJson);

  const idClaims: JwtClaims = {
    iss: issuer,
    sub: user.id,
    aud: client.id,
    exp: iat + TOKEN_TTL_SECONDS,
    iat,
    auth_time: issued.authTime,
    ...session,
    ...profileClaims(user),
  };

  if (issued.nonce) {
    idClaims.nonce = issued.nonce;
  }

  // A session from before `amr` was kept says nothing about the sign-in, so the token leaves the claim out.
  if (amr.length) {
    idClaims.amr = amr;
  }

  if (issued.role) {
    idClaims.role = issued.role;
  }

  const idToken = await signJwt(idClaims, key);

  // The access token opens `/oauth/userinfo` alone.
  const accessToken = await signJwt(
    {
      iss: issuer,
      sub: user.id,
      aud: issuer,
      client_id: client.id,
      scope: issued.scope,
      exp: iat + TOKEN_TTL_SECONDS,
      iat,
      jti: randomToken(16),
      ...session,
    },
    key,
    { typ: "at+jwt" }
  );

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    id_token: idToken,
    scope: issued.scope,
  });
};

// ---------- userinfo ----------

const userinfo = async (
  request: Request,
  env: Env,
  db: Database,
  now: number
): Promise<Response> => {
  const unauthorized = (description: string) =>
    json({ error: "invalid_token", error_description: description }, 401, {
      ...NO_STORE,
      "WWW-Authenticate": `Bearer realm="${env.APP_NAME}", error="invalid_token"`,
    });

  const bearer = /^Bearer\s+(?<token>\S+)$/iu.exec(
    request.headers.get("authorization") ?? ""
  )?.groups?.token;

  if (!bearer) {
    return unauthorized("Send an access token as a Bearer token.");
  }

  const issuer = issuerOf(env);

  const claims = await verifyJwt(bearer, {
    keys: await publicJwks(db, env, now),
    issuer,
    audience: issuer,
    typ: "at+jwt",
    now,
  });

  const sub = stringOrNull(claims?.sub);

  if (!sub) {
    return unauthorized("The access token is not valid.");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, sub),
  });

  if (!user?.active) {
    return unauthorized("This person can no longer sign in.");
  }

  const answer: JwtClaims = { sub: user.id, ...profileClaims(user) };
  const sid = stringOrNull(claims?.sid);

  if (sid) {
    answer.sid = sid;
  }

  return json(answer);
};

// ---------- RP-initiated logout ----------

/** The client an `id_token_hint` names, when the hint is a token of ours (expired or not). */
const hintedClient = async (
  env: Env,
  db: Database,
  hint: string | null,
  now: number
): Promise<string | null> => {
  if (!hint) {
    return null;
  }

  // The hint may be expired by now; its signature and issuer still have to be ours.
  const exp = numberOr(decodeJwt(hint)?.claims.exp, now / 1000);

  const claims = await verifyJwt(hint, {
    keys: await publicJwks(db, env, now),
    issuer: issuerOf(env),
    now: exp * 1000,
  });

  return stringOrNull(claims?.aud);
};

const endSession = async (
  request: Request,
  env: Env,
  db: Database,
  now: number
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed("GET, POST");
  }

  const params = await requestParams(request);
  const named = params.get("client_id");
  const hinted = await hintedClient(env, db, params.get("id_token_hint"), now);
  // A hint for another client than the one named is ignored, and so is the post-logout address then.
  const clientId = hinted && (!named || named === hinted) ? hinted : named;
  const requested = normaliseUri(params.get("post_logout_redirect_uri"));
  const client = clientId ? await findClient(db, clientId) : null;
  let location = "/login";

  if (requested && client?.active && postLogoutUriAllowed(client, requested)) {
    const url = new URL(requested);
    const state = params.get("state");

    if (state) {
      url.searchParams.set("state", state);
    }

    location = url.href;
  }

  return redirectTo(location, await endCurrentSession(request, env));
};

// ---------- dispatch ----------

/** The provider's answer for one of `SSO_PATHS`; a 404 for any other path. `now` is the tests' clock. */
export const handleSsoRequest = async (
  request: Request,
  env: Env,
  db: Database,
  now = Date.now()
): Promise<Response> => {
  const { pathname } = new URL(request.url);

  switch (pathname) {
    case SSO_PATHS.discovery: {
      return json(discoveryDocument(issuerOf(env)), 200, PUBLIC);
    }

    case SSO_PATHS.jwks: {
      return json({ keys: await publicJwks(db, env, now) }, 200, PUBLIC);
    }

    case SSO_PATHS.authorize: {
      return authorize(request, env, db, now);
    }

    case SSO_PATHS.token: {
      return token(request, env, db, now);
    }

    case SSO_PATHS.userinfo: {
      return userinfo(request, env, db, now);
    }

    case SSO_PATHS.logout: {
      return endSession(request, env, db, now);
    }

    default: {
      return new Response("not found", { status: 404 });
    }
  }
};
