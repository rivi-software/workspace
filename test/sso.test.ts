// The workspace as an OpenID Connect identity provider (single sign-on, `app/lib/sso/`): the discovery document and key
// set, the authorization code flow with PKCE as an application drives it by hand, the token and userinfo endpoints,
// who may sign in to which application, a fresh sign-in an application asks for, the key's rotation, the logout, and
// what an ID token's `amr` says about how the person signed in (`amrForSignIn` in `app/lib/auth.server.ts`).
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { oauthCodes, sessions } from "~/db/schema";
import {
  amrForSignIn,
  getSessionIdentity,
  passkeyVerifiedUser,
} from "~/lib/auth.server";
import {
  base64UrlEncode,
  codeChallenge,
  generateCodeVerifier,
  sha256Hex,
} from "~/lib/crypto";
import { isJsonObject, numberOr, stringOrNull } from "~/lib/guards";
import { passwordSignIn, secondFactorSignIn } from "~/lib/sign-in.server";
import {
  SsoAdminError,
  applicationForNext,
  createClient,
  listApps,
  parseUriList,
  removeClientMember,
  rotateClientSecret,
  setClientActive,
  setClientMember,
  updateClient,
} from "~/lib/sso/clients.server";
import type { SsoClientInput } from "~/lib/sso/clients.server";
import { decodeJwt, verifyJwt } from "~/lib/sso/jwt";
import type { Jwk, JwtClaims } from "~/lib/sso/jwt";
import {
  currentSigningKey,
  publicJwks,
  rotateSigningKey,
} from "~/lib/sso/keys.server";
import { handleSsoRequest, issuerOf } from "~/lib/sso/provider.server";
import { setPersonActive } from "~/lib/users.server";

import { cookiesOf, enrolAuthenticator } from "./authenticator";
import {
  PASSWORD,
  adminMailbox,
  db,
  defined,
  mailbox,
  parseJson,
  sessionCookieOf,
  sessionFor,
  thrown,
  withCookie,
} from "./fixtures";
import type { Json } from "./fixtures";

const issuer = issuerOf(env);
const REDIRECT = "https://supsys.test/auth/sso/callback";
const LOGGED_OUT = "https://supsys.test/login";
const MINUTE = 60_000;

/** A JSON value's object, or an empty one; its members are read by name. */
const obj = (value: Json | undefined): { [key: string]: Json } =>
  isJsonObject(value) && !Array.isArray(value) ? value : {};

const str = (value: Json | undefined): string => stringOrNull(value) ?? "";

/** A JSON answer's members, read by name; `{}` for anything else. */
const jsonOf = async (res: Response) => obj(parseJson(await res.text()));

/** A request to the identity provider through the Worker, as an application or a browser sends it (no redirect followed). */
const fetchSelf = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${issuer}${path}`, { redirect: "manual", ...init });

/** Where a 302 sends the browser, resolved against the issuer; null for any other answer. */
const locationOf = (res: Response): URL | null => {
  const location = res.headers.get("location");

  return res.status === 302 && location ? new URL(location, issuer) : null;
};

/** The `error` an answer sends back to the application, or null. */
const errorOf = (res: Response) =>
  locationOf(res)?.searchParams.get("error") ?? null;

const admin = () => adminMailbox("sso-admin", "Alex Admin");

/** An application an admin registered: Supsys, with its secret. */
const application = async (over: Partial<SsoClientInput> = {}) =>
  createClient(db, await admin(), {
    name: "Supsys",
    redirectUris: REDIRECT,
    postLogoutRedirectUris: LOGGED_OUT,
    launchUrl: "https://supsys.test/app/inbox",
    pkceRequired: true,
    access: "everyone",
    ...over,
  });

/** A browser signed in as a new person, through Better Auth's password sign-in. */
const signedIn = async (local: string, name = "Rik Visser") => {
  const user = await mailbox(local, name);

  return { user, cookie: await sessionFor(user) };
};

/** An authorization request's parameters for the application, with PKCE for `verifier`. */
const authorizeParams = async (
  clientId: string,
  verifier: string,
  extra: Record<string, string> = {}
): Promise<Record<string, string>> => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  scope: "openid email profile",
  state: "st-1",
  nonce: "nc-1",
  code_challenge: await codeChallenge(verifier),
  code_challenge_method: "S256",
  ...extra,
});

const authorizePath = (params: Record<string, string>) =>
  `/oauth/authorize?${new URLSearchParams(params).toString()}`;

/** The authorization request of a browser with this `cookie` header; `now` is the provider's clock. */
const authorize = (
  cookie: string | null,
  params: Record<string, string>,
  now?: number
) => {
  const headers = new Headers();

  if (cookie) {
    headers.set("cookie", cookie);
  }

  return handleSsoRequest(
    new Request(`${issuer}${authorizePath(params)}`, { headers }),
    env,
    db,
    now
  );
};

/** The code an authorization request sends back to the application's redirect URI. */
const codeFor = async (
  cookie: string,
  params: Record<string, string>,
  now?: number
): Promise<string> => {
  const back = locationOf(await authorize(cookie, params, now));

  return defined(
    back?.href.startsWith(`${REDIRECT}?`)
      ? back.searchParams.get("code")
      : null,
    "a code at the redirect URI"
  );
};

interface TokenRequest {
  form: Record<string, string>;
  /** `client_secret_basic`; null sends no Authorization header. */
  basic: { id: string; secret: string } | null;
  contentType?: string;
  body?: string;
  now?: number;
}

const tokenRequest = (request: TokenRequest) => {
  const headers = new Headers({
    "content-type": request.contentType ?? "application/x-www-form-urlencoded",
  });

  if (request.basic) {
    headers.set(
      "authorization",
      `Basic ${btoa(`${request.basic.id}:${request.basic.secret}`)}`
    );
  }

  return handleSsoRequest(
    new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers,
      body: request.body ?? new URLSearchParams(request.form).toString(),
    }),
    env,
    db,
    request.now
  );
};

/** What the token endpoint answers: its status and the OAuth `error`, if any. */
const tokenOutcome = async (request: TokenRequest) => {
  const res = await tokenRequest(request);
  const body = await jsonOf(res);

  return { status: res.status, error: stringOrNull(body.error) };
};

const refused = (error: string) => ({ status: 400, error });

/** The token request for a code, with the verifier it was made for. */
const codeForm = (code: string, verifier: string) => ({
  grant_type: "authorization_code",
  code,
  redirect_uri: REDIRECT,
  code_verifier: verifier,
});

/** The key set as an application reads it, from `/oauth/jwks`. */
const jwksOf = async (): Promise<Jwk[]> => {
  const { keys } = await jsonOf(await fetchSelf("/oauth/jwks"));

  return (Array.isArray(keys) ? keys : []).map((value) => {
    const key = obj(value);
    const jwk: Jwk = { kty: str(key.kty) };

    for (const name of ["crv", "x", "y", "d", "kid", "alg", "use"] as const) {
      const member = stringOrNull(key[name]);

      if (member) {
        jwk[name] = member;
      }
    }

    return jwk;
  });
};

/** An ID token's claims, verified against the key set as the application would. */
const idClaims = async (
  idToken: string,
  clientId: string
): Promise<JwtClaims | null> =>
  verifyJwt(idToken, { keys: await jwksOf(), issuer, audience: clientId });

/** A signed-in person's way through an application's sign-in: the code, then the tokens with the client's secret. */
const signInTo = async (
  cookie: string,
  client: { id: string; secret: string },
  extra: Record<string, string> = {}
) => {
  const verifier = generateCodeVerifier();
  const params = await authorizeParams(client.id, verifier, extra);
  const code = await codeFor(cookie, params);

  const res = await tokenRequest({
    form: codeForm(code, verifier),
    basic: client,
  });

  const tokens = await jsonOf(res);
  const idToken = str(tokens.id_token);

  return {
    status: res.status,
    tokens,
    idToken,
    accessToken: str(tokens.access_token),
    claims: defined(
      await idClaims(idToken, client.id),
      "an ID token that verifies"
    ),
  };
};

const userinfo = (token: string) =>
  fetchSelf("/oauth/userinfo", {
    headers: { authorization: `Bearer ${token}` },
  });

const identityOf = (cookie: string) =>
  getSessionIdentity(withCookie(cookie), env, db);

const logout = (cookie: string, params: Record<string, string>) =>
  fetchSelf(`/oauth/logout?${new URLSearchParams(params).toString()}`, {
    headers: { cookie },
  });

/** Authenticator data with this flags byte: the 32-byte RP ID hash, the flags, a 4-byte counter. */
const authenticatorData = (flags: number) => {
  const bytes = new Uint8Array(37);
  bytes[32] = flags;

  return base64UrlEncode(bytes);
};

const amrOf = (
  path: string,
  over: Partial<Parameters<typeof amrForSignIn>[0]> = {}
) =>
  amrForSignIn({
    path,
    authenticatorData: null,
    twoFactorEnabled: false,
    current: null,
    ...over,
  });

describe("the identity provider", () => {
  it("publishes its discovery document and key set", async () => {
    const discovery = await jsonOf(
      await fetchSelf("/.well-known/openid-configuration")
    );

    const keys = await jwksOf();
    const current = await currentSigningKey(db, env);

    expect({
      discovery,
      current: keys.find((k) => k.kid === current.kid),
      // The private half never leaves the database.
      privateHalves: keys.filter((k) => k.d !== undefined),
    }).toMatchObject({
      discovery: {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        jwks_uri: `${issuer}/oauth/jwks`,
        userinfo_endpoint: `${issuer}/oauth/userinfo`,
        end_session_endpoint: `${issuer}/oauth/logout`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
        ],
      },
      current: { kty: "EC", crv: "P-256", alg: "ES256", use: "sig" },
      privateHalves: [],
    });
  });

  it("checks the redirect URIs an admin registers, and a secret it rotates", async () => {
    const wrongLists = [
      "http://a.test/cb",
      "https://a.test/cb#frag",
      "not a url",
      "",
    ].map(
      (text) =>
        thrown(() => {
          parseUriList(text);
        }) instanceof SsoAdminError
    );

    const { client, secret } = await application();
    const signer = await signedIn("sso-rotated");
    const rotated = await rotateClientSecret(db, client.id);
    // The secret shown before stops working at once.
    const verifier = generateCodeVerifier();
    const params = await authorizeParams(client.id, verifier);

    const stale = await tokenOutcome({
      form: codeForm(await codeFor(signer.cookie, params), verifier),
      basic: { id: client.id, secret },
    });

    const fresh = await signInTo(signer.cookie, {
      id: client.id,
      secret: rotated,
    });

    expect({
      list: parseUriList(
        "https://a.test/cb\nhttps://a.test/cb, http://localhost:5173/cb"
      ),
      wrongLists,
      secret: /^wss_[\w-]{43}$/u.test(secret),
      stale,
      fresh: fresh.claims.sub,
    }).toStrictEqual({
      list: ["https://a.test/cb", "http://localhost:5173/cb"],
      wrongLists: [true, true, true, true],
      secret: true,
      stale: { status: 401, error: "invalid_client" },
      fresh: signer.user.id,
    });
  });

  it("sends a stranger to sign in first, and answers prompt=none with login_required", async () => {
    const { client } = await application();
    const params = await authorizeParams(client.id, generateCodeVerifier());
    const login = locationOf(await fetchSelf(authorizePath(params)));

    const back = locationOf(
      await fetchSelf(authorizePath({ ...params, prompt: "none" }))
    );

    expect({
      login: login?.pathname,
      next: login?.searchParams.get("next"),
      back: back?.origin + (back?.pathname ?? ""),
      error: back?.searchParams.get("error"),
      state: back?.searchParams.get("state"),
      iss: back?.searchParams.get("iss"),
    }).toStrictEqual({
      login: "/login",
      next: authorizePath(params),
      back: REDIRECT,
      error: "login_required",
      state: "st-1",
      iss: issuer,
    });
  });

  it("answers an unknown application or redirect URI on an error page, never through a redirect", async () => {
    const { cookie } = await signedIn("sso-error-page");
    const { client } = await application();
    const good = await authorizeParams(client.id, generateCodeVerifier());

    const page = async (params: Record<string, string>) => {
      const res = await authorize(cookie, params);
      const text = await res.text();

      return {
        status: res.status,
        location: res.headers.get("location"),
        html: res.headers.get("content-type")?.includes("text/html") ?? false,
        unknown: text.includes("Unknown application"),
        notRegistered: text.includes("not registered"),
      };
    };

    const unknown = await page({ ...good, client_id: "app_nope" });

    const elsewhere = await page({
      ...good,
      redirect_uri: "https://evil.test/cb",
    });

    const climbed = await page({ ...good, redirect_uri: `${REDIRECT}/../x` });
    await setClientActive(db, client.id, false);
    const inactive = await page(good);

    const errorPage = { status: 400, location: null, html: true };

    expect({ unknown, elsewhere, climbed, inactive }).toStrictEqual({
      unknown: { ...errorPage, unknown: true, notRegistered: false },
      elsewhere: { ...errorPage, unknown: false, notRegistered: true },
      climbed: { ...errorPage, unknown: false, notRegistered: true },
      inactive: { ...errorPage, unknown: true, notRegistered: false },
    });
  });

  it("refuses a request it cannot answer through the redirect URI, and PKCE only where the application may go without", async () => {
    const { cookie } = await signedIn("sso-refused");
    const { client } = await application();
    const good = await authorizeParams(client.id, generateCodeVerifier());
    const noPkce = { ...good };
    delete noPkce.code_challenge;
    delete noPkce.code_challenge_method;

    const back = async (params: Record<string, string>) => {
      const location = locationOf(await authorize(cookie, params));

      return {
        to: location ? location.origin + location.pathname : null,
        state: location?.searchParams.get("state") ?? null,
        code: location?.searchParams.get("code") ?? null,
        error: location?.searchParams.get("error") ?? null,
      };
    };

    const refusedWith = (error: string) => ({
      to: REDIRECT,
      state: "st-1",
      code: null,
      error,
    });

    const refusals = {
      responseType: await back({ ...good, response_type: "token" }),
      scope: await back({ ...good, scope: "email profile" }),
      responseMode: await back({ ...good, response_mode: "fragment" }),
      plain: await back({ ...good, code_challenge_method: "plain" }),
      short: await back({ ...good, code_challenge: "short" }),
      noPkce: await back(noPkce),
    };

    // An application that cannot do PKCE may be let in without it.
    await updateClient(db, client.id, {
      name: "Supsys",
      redirectUris: REDIRECT,
      postLogoutRedirectUris: "",
      launchUrl: "",
      pkceRequired: false,
      access: "everyone",
    });

    const without = await codeFor(cookie, noPkce);

    expect({ refusals, without: /^[\w-]{43}$/u.test(without) }).toStrictEqual({
      refusals: {
        responseType: refusedWith("unsupported_response_type"),
        scope: refusedWith("invalid_scope"),
        responseMode: refusedWith("invalid_request"),
        plain: refusedWith("invalid_request"),
        short: refusedWith("invalid_request"),
        noPkce: refusedWith("invalid_request"),
      },
      without: true,
    });
  });

  it("signs a person in to an application: code, tokens, ID token", async () => {
    const { user, cookie } = await signedIn("sso-flow");
    const { client, secret } = await application();
    const identity = defined(await identityOf(cookie), "the session");
    const verifier = generateCodeVerifier();
    const params = await authorizeParams(client.id, verifier);
    const back = locationOf(await authorize(cookie, params));
    const code = defined(back?.searchParams.get("code"), "a code");

    // The code is kept as its hash.
    const byCode = await db.query.oauthCodes.findFirst({
      where: eq(oauthCodes.codeHash, code),
    });

    const byHash = await db.query.oauthCodes.findFirst({
      where: eq(oauthCodes.codeHash, await sha256Hex(code)),
    });

    const res = await tokenRequest({
      form: codeForm(code, verifier),
      basic: { id: client.id, secret },
    });

    const tokens = await jsonOf(res);
    const claims = await idClaims(str(tokens.id_token), client.id);
    const accessToken = decodeJwt(str(tokens.access_token));

    expect({
      back: [back?.searchParams.get("state"), back?.searchParams.get("iss")],
      stored: [byCode, byHash?.userId],
      answer: [res.status, res.headers.get("cache-control")],
      tokens: [tokens.token_type, tokens.expires_in, tokens.scope],
      claims,
      accessToken: accessToken?.header.typ,
    }).toStrictEqual({
      back: ["st-1", issuer],
      stored: [undefined, user.id],
      answer: [200, "no-store"],
      tokens: ["Bearer", 3600, "openid email profile"],
      // "everyone" without a list names no role.
      claims: {
        iss: issuer,
        sub: user.id,
        aud: client.id,
        exp: numberOr(claims?.iat, 0) + 3600,
        iat: claims?.iat,
        auth_time: identity.authTime,
        sid: identity.sid,
        nonce: "nc-1",
        email: user.email,
        email_verified: true,
        name: "Rik Visser",
        amr: ["pwd"],
      },
      accessToken: "at+jwt",
    });
  });

  it("answers userinfo for the access token alone, and redeems a code once", async () => {
    const { user, cookie } = await signedIn("sso-userinfo");
    const { client, secret } = await application();
    const identity = defined(await identityOf(cookie), "the session");
    const verifier = generateCodeVerifier();
    const params = await authorizeParams(client.id, verifier);
    const code = await codeFor(cookie, params);
    const basic = { id: client.id, secret };
    const first = await tokenRequest({ form: codeForm(code, verifier), basic });
    const tokens = await jsonOf(first);
    const info = await userinfo(str(tokens.access_token));
    const withIdToken = await userinfo(str(tokens.id_token));
    const withNothing = await fetchSelf("/oauth/userinfo");

    expect({
      info: [info.status, await jsonOf(info)],
      // An ID token is not an access token.
      withIdToken: withIdToken.status,
      withNothing: withNothing.status,
      again: await tokenOutcome({ form: codeForm(code, verifier), basic }),
    }).toStrictEqual({
      info: [
        200,
        {
          sub: user.id,
          email: user.email,
          email_verified: true,
          name: "Rik Visser",
          sid: identity.sid,
        },
      ],
      withIdToken: 401,
      withNothing: 401,
      again: refused("invalid_grant"),
    });
  });

  it("requires the PKCE verifier the challenge was made from", async () => {
    const { cookie } = await signedIn("sso-pkce");
    const { client, secret } = await application();
    const basic = { id: client.id, secret };
    const verifier = generateCodeVerifier();
    const params = await authorizeParams(client.id, verifier);

    const redeem = async (codeVerifier: string | null) => {
      const form: Record<string, string> = codeForm(
        await codeFor(cookie, params),
        verifier
      );

      if (codeVerifier === null) {
        delete form.code_verifier;
      } else {
        form.code_verifier = codeVerifier;
      }

      return tokenOutcome({ form, basic });
    };

    expect({
      missing: await redeem(null),
      other: await redeem(generateCodeVerifier()),
      short: await redeem("short"),
      right: await redeem(verifier),
    }).toStrictEqual({
      missing: refused("invalid_grant"),
      other: refused("invalid_grant"),
      short: refused("invalid_grant"),
      right: { status: 200, error: null },
    });
  });

  it("takes the client's secret in the header or the form, and refuses a wrong one", async () => {
    const { cookie } = await signedIn("sso-secret");
    const { client, secret } = await application();
    const basic = { id: client.id, secret };
    const verifier = generateCodeVerifier();
    const params = await authorizeParams(client.id, verifier);
    const fresh = async () => codeForm(await codeFor(cookie, params), verifier);

    const wrong = await tokenRequest({
      form: await fresh(),
      basic: { id: client.id, secret: "wrong" },
    });

    const outcomes = {
      wrongPosted: await tokenOutcome({
        form: { ...(await fresh()), client_id: client.id, client_secret: "x" },
        basic: null,
      }),
      none: await tokenOutcome({ form: await fresh(), basic: null }),
      // client_secret_post works as well as the header.
      posted: await tokenOutcome({
        form: {
          ...(await fresh()),
          client_id: client.id,
          client_secret: secret,
        },
        basic: null,
      }),
      otherRedirect: await tokenOutcome({
        form: { ...(await fresh()), redirect_uri: "https://supsys.test/other" },
        basic,
      }),
      unknownCode: await tokenOutcome({
        form: { ...(await fresh()), code: "nope" },
        basic,
      }),
      grant: await tokenOutcome({
        form: { ...(await fresh()), grant_type: "client_credentials" },
        basic,
      }),
      json: await tokenOutcome({
        form: {},
        basic,
        contentType: "application/json",
        body: "{}",
      }),
    };

    const wrongBody = await jsonOf(wrong);

    expect({
      wrong: [
        wrong.status,
        wrong.headers.get("www-authenticate")?.startsWith("Basic "),
        wrongBody.error,
      ],
      outcomes,
    }).toStrictEqual({
      wrong: [401, true, "invalid_client"],
      outcomes: {
        wrongPosted: { status: 401, error: "invalid_client" },
        none: { status: 401, error: "invalid_client" },
        posted: { status: 200, error: null },
        otherRedirect: refused("invalid_grant"),
        unknownCode: refused("invalid_grant"),
        grant: refused("unsupported_grant_type"),
        json: refused("invalid_request"),
      },
    });
  });

  it("redeems a code within two minutes only", async () => {
    const { cookie } = await signedIn("sso-expiry");
    const { client, secret } = await application();
    const verifier = generateCodeVerifier();
    const params = await authorizeParams(client.id, verifier);
    const issuedAt = Date.now();

    const redeemAfter = async (ms: number) =>
      tokenOutcome({
        form: codeForm(await codeFor(cookie, params, issuedAt), verifier),
        basic: { id: client.id, secret },
        now: issuedAt + ms,
      });

    expect({
      inTime: await redeemAfter(119_000),
      late: await redeemAfter(121_000),
    }).toStrictEqual({
      inTime: { status: 200, error: null },
      late: refused("invalid_grant"),
    });
  });

  it("lets no code redeem for a person deactivated since it was issued", async () => {
    const { user, cookie } = await signedIn("sso-deactivated");
    const { client, secret } = await application();
    const verifier = generateCodeVerifier();
    const params = await authorizeParams(client.id, verifier);
    const code = await codeFor(cookie, params);

    await setPersonActive(db, await admin(), user.id, false);

    const redeemed = await tokenOutcome({
      form: codeForm(code, verifier),
      basic: { id: client.id, secret },
    });

    // Nor does the browser get a new code: the session ended with the deactivation.
    const again = locationOf(await authorize(cookie, params));

    expect({ redeemed, again: again?.pathname }).toStrictEqual({
      redeemed: refused("invalid_grant"),
      again: "/login",
    });
  });

  it("rotates its signing key and keeps the old one verifying for a day", async () => {
    const { cookie } = await signedIn("sso-rotation");
    const { client, secret } = await application();
    const before = await currentSigningKey(db, env);
    const signedBefore = await signInTo(cookie, { id: client.id, secret });
    const after = await rotateSigningKey(db, env);
    const keys = await jwksOf();
    const kids = new Set(keys.map((k) => k.kid));
    const stillVerifies = await idClaims(signedBefore.idToken, client.id);

    // A day later the retired key is gone from the key set.
    const later = await publicJwks(db, env, Date.now() + 25 * 60 * MINUTE);

    // The access token signed before still opens userinfo, and new tokens carry the new key.
    const info = await userinfo(signedBefore.accessToken);
    const signedAfter = await signInTo(cookie, { id: client.id, secret });

    expect({
      rotated: after.kid !== before.kid,
      both: [kids.has(before.kid), kids.has(after.kid)],
      stillVerifies: stillVerifies !== null,
      later: [
        later.some((k) => k.kid === before.kid),
        later.some((k) => k.kid === after.kid),
      ],
      kids: [
        decodeJwt(signedBefore.accessToken)?.header.kid,
        info.status,
        decodeJwt(signedAfter.idToken)?.header.kid,
      ],
    }).toStrictEqual({
      rotated: true,
      both: [true, true],
      stillVerifies: true,
      later: [false, true],
      kids: [before.kid, 200, after.kid],
    });
  });

  it("ends the session for an application, and goes back to a registered address only", async () => {
    const { client, secret } = await application();
    const first = await signedIn("sso-logout");

    const elsewhere = await logout(first.cookie, {
      client_id: client.id,
      post_logout_redirect_uri: "https://evil.test/",
      state: "x",
    });

    const firstAfter = await identityOf(first.cookie);

    // An ID token names the application instead of its id, and the state goes along.
    const second = await sessionFor(first.user);
    const { idToken } = await signInTo(second, { id: client.id, secret });

    const home = await logout(second, {
      id_token_hint: idToken,
      post_logout_redirect_uri: LOGGED_OUT,
      state: "x",
    });

    const secondAfter = await identityOf(second);

    // A registered address of another application is no address of this one.
    const other = await application({
      name: "Other",
      redirectUris: "https://other.test/cb",
      postLogoutRedirectUris: "https://other.test/bye",
    });

    const crossed = await logout(await sessionFor(first.user), {
      client_id: other.client.id,
      post_logout_redirect_uri: LOGGED_OUT,
    });

    expect({
      elsewhere: [
        elsewhere.headers.get("location"),
        sessionCookieOf(elsewhere)?.endsWith("="),
        firstAfter,
      ],
      home: [home.headers.get("location"), secondAfter],
      crossed: crossed.headers.get("location"),
    }).toStrictEqual({
      elsewhere: ["/login", true, null],
      home: [`${LOGGED_OUT}?state=x`, null],
      crossed: "/login",
    });
  });
});

describe("application access lists and fresh sign-ins", () => {
  it("lets only listed people in, with the role the list names, and keeps the Apps menu honest", async () => {
    const { user, cookie } = await signedIn("sso-listed", "Listed Person");
    const owner = await admin();

    const { client, secret } = await application({
      name: "RadioTools admin",
      access: "listed",
    });

    const params = await authorizeParams(client.id, generateCodeVerifier());
    const turnedAway = locationOf(await authorize(cookie, params));
    const appsBefore = await listApps(db, user.id);

    await setClientMember(db, owner, client.id, user.id, " SuperAdmin ");

    const allowed = await signInTo(cookie, { id: client.id, secret });
    const appsListed = await listApps(db, user.id);
    const appsOwner = await listApps(db, owner.id);

    await removeClientMember(db, client.id, user.id);
    const removed = errorOf(await authorize(cookie, params));

    expect({
      turnedAway: [
        turnedAway?.searchParams.get("error"),
        turnedAway?.searchParams.get("error_description")?.includes(user.email),
        turnedAway?.searchParams.get("state"),
      ],
      apps: [
        appsBefore.some((a) => a.id === client.id),
        appsListed.find((a) => a.id === client.id),
        appsOwner.some((a) => a.id === client.id),
      ],
      role: allowed.claims.role,
      removed,
    }).toStrictEqual({
      turnedAway: ["access_denied", true, "st-1"],
      apps: [
        false,
        {
          id: client.id,
          name: "RadioTools admin",
          launchUrl: "https://supsys.test/app/inbox",
        },
        false,
      ],
      role: "superadmin",
      removed: "access_denied",
    });
  });

  it("names a listed person's role in an application open to everyone, and lets the rest in without one", async () => {
    const listed = await signedIn("sso-open-listed");
    const someone = await signedIn("sso-unlisted");
    const { client, secret } = await application({ name: "Open" });

    await setClientMember(
      db,
      await admin(),
      client.id,
      listed.user.id,
      "editor"
    );

    const withRole = await signInTo(listed.cookie, { id: client.id, secret });
    const without = await signInTo(someone.cookie, { id: client.id, secret });

    expect({
      withRole: withRole.claims.role,
      without: without.claims.role,
    }).toStrictEqual({ withRole: "editor", without: undefined });
  });

  it("lists in the Apps menu only active applications with a launch link, and names one a sign-in continues to", async () => {
    const user = await mailbox("sso-apps");
    const launched = await application({ name: "Launched" });
    const headless = await application({ name: "Headless", launchUrl: "" });

    const ids = async () => {
      const apps = await listApps(db, user.id);

      return [
        apps.some((a) => a.id === launched.client.id),
        apps.some((a) => a.id === headless.client.id),
      ];
    };

    const next = authorizePath(
      await authorizeParams(launched.client.id, generateCodeVerifier())
    );

    const before = {
      apps: await ids(),
      next: await applicationForNext(db, next),
      notAuthorize: await applicationForNext(db, "/mail?client_id=x"),
      none: await applicationForNext(db, undefined),
      unknown: await applicationForNext(
        db,
        "/oauth/authorize?client_id=app_nope"
      ),
    };

    await setClientActive(db, launched.client.id, false);

    expect({
      before,
      after: { apps: await ids(), next: await applicationForNext(db, next) },
    }).toStrictEqual({
      before: {
        apps: [true, false],
        next: "Launched",
        notAuthorize: null,
        none: null,
        unknown: null,
      },
      after: { apps: [false, false], next: null },
    });
  });

  it("asks for a fresh sign-in when the application says so, and takes the new session", async () => {
    const { user, cookie } = await signedIn("sso-stale", "Stale Session");
    const { client } = await application();
    const params = await authorizeParams(client.id, generateCodeVerifier());
    // The provider's clock ten minutes after the sign-in.
    const tenMinutesOn = Date.now() + 10 * MINUTE;

    const demand = async (extra: Record<string, string>) => {
      const login = locationOf(
        await authorize(cookie, { ...params, ...extra }, tenMinutesOn)
      );

      const next = new URL(login?.searchParams.get("next") ?? "/", issuer);

      return {
        to: login?.pathname,
        reauth: login?.searchParams.get("reauth"),
        next: next.pathname,
        prompt: next.searchParams.get("prompt"),
        client: next.searchParams.get("client_id"),
      };
    };

    const sentToSignIn = {
      to: "/login",
      reauth: "1",
      next: "/oauth/authorize",
      prompt: null,
      client: client.id,
    };

    const demands = {
      // Without a demand, the old session will do, and so with a long max_age.
      none: errorOf(await authorize(cookie, params, tenMinutesOn)),
      longMaxAge: errorOf(
        await authorize(cookie, { ...params, max_age: "3600" }, tenMinutesOn)
      ),
      login: await demand({ prompt: "login" }),
      maxAge: await demand({ max_age: "60" }),
      silent: errorOf(
        await authorize(
          cookie,
          { ...params, prompt: "none login" },
          tenMinutesOn
        )
      ),
    };

    // The fresh sign-in replaces the old session and answers the demand.
    const old = defined(await identityOf(cookie), "the old session");

    const fresh = await passwordSignIn(
      new Request(`${issuer}/login`, {
        method: "POST",
        headers: { cookie, "cf-connecting-ip": "203.0.113.41" },
      }),
      env,
      db,
      {
        email: user.email,
        password: PASSWORD,
        next: authorizePath({ ...params, max_age: "60" }),
        reauth: true,
      }
    );

    const oldRow = await db.query.sessions.findFirst({
      where: eq(sessions.id, old.sid),
    });

    const renewed = defined(sessionCookieOf(fresh), "the new session");

    const answered = locationOf(
      await authorize(renewed, { ...params, prompt: "login" })
    );

    expect({
      demands,
      fresh: locationOf(fresh)?.pathname,
      oldRow,
      answered: answered?.searchParams.has("code"),
    }).toStrictEqual({
      demands: {
        none: null,
        longMaxAge: null,
        login: sentToSignIn,
        maxAge: sentToSignIn,
        silent: "login_required",
      },
      fresh: "/oauth/authorize",
      oldRow: undefined,
      answered: true,
    });
  });
});

describe("how a session was signed in (amr)", () => {
  it("reads the User Verified flag of a passkey's assertion", () => {
    expect({
      // User Present and User Verified.
      verified: passkeyVerifiedUser(authenticatorData(0x05)),
      // User Present alone.
      present: passkeyVerifiedUser(authenticatorData(0x01)),
      none: passkeyVerifiedUser(null),
      empty: passkeyVerifiedUser(""),
      short: passkeyVerifiedUser(base64UrlEncode(new Uint8Array(8))),
      garbage: passkeyVerifiedUser("not base64url!"),
    }).toStrictEqual({
      verified: true,
      present: false,
      none: false,
      empty: false,
      short: false,
      garbage: false,
    });
  });

  it("names the methods by the endpoint that made the session", () => {
    expect({
      password: amrOf("/sign-in/email"),
      passwordWithApp: amrOf("/sign-in/email", { twoFactorEnabled: true }),
      code: amrOf("/two-factor/verify-totp"),
      backupCode: amrOf("/two-factor/verify-backup-code"),
      passkeyVerified: amrOf("/passkey/verify-authentication", {
        authenticatorData: authenticatorData(0x05),
      }),
      passkey: amrOf("/passkey/verify-authentication", {
        authenticatorData: authenticatorData(0x01),
      }),
      // A session made anew for someone signed in keeps what the one before said; from nowhere, nothing.
      renewed: amrOf("/two-factor/enable", { current: "pwd" }),
      unknown: amrOf("/change-password"),
    }).toStrictEqual({
      password: "pwd",
      passwordWithApp: "pwd mfa",
      code: "pwd otp mfa",
      backupCode: "pwd otp mfa",
      passkeyVerified: "pop mfa",
      passkey: "pop",
      renewed: "pwd",
      unknown: null,
    });
  });

  it("records the authenticator app's code as pwd otp mfa, and tells the application", async () => {
    const user = await mailbox("sso-totp", "Totp Person");
    const app = await enrolAuthenticator(user);
    const { client, secret } = await application();

    const secondFactor = async (code: string, backup: boolean) => {
      const step = await passwordSignIn(
        new Request(`${issuer}/login`, {
          method: "POST",
          headers: { "cf-connecting-ip": "203.0.113.42" },
        }),
        env,
        db,
        { email: user.email, password: PASSWORD, next: "/mail" }
      );

      const done = await secondFactorSignIn(
        new Request(`${issuer}/two-factor`, {
          method: "POST",
          headers: { cookie: cookiesOf(step) },
        }),
        env,
        { code, backup, trust: false, next: "/mail" }
      );

      const cookie = defined(sessionCookieOf(done), "the session");
      const identity = await identityOf(cookie);

      return {
        // No session yet after the password: the code's page first.
        step: [
          locationOf(step)?.pathname,
          sessionCookieOf(step)?.endsWith("="),
        ],
        done: locationOf(done)?.pathname,
        amr: identity?.amr,
        cookie,
      };
    };

    const { cookie, ...withCode } = await secondFactor(await app.code(), false);
    const token = await signInTo(cookie, { id: client.id, secret });

    const { cookie: _backup, ...withBackup } = await secondFactor(
      defined(app.backupCodes[0], "a backup code"),
      true
    );

    const signedIn2fa = {
      step: ["/two-factor", true],
      done: "/mail",
      amr: ["pwd", "otp", "mfa"],
    };

    expect({ withCode, withBackup, token: token.claims.amr }).toStrictEqual({
      withCode: signedIn2fa,
      withBackup: signedIn2fa,
      token: ["pwd", "otp", "mfa"],
    });
  });

  it("leaves amr out of the ID token of a session that recorded nothing", async () => {
    const user = await mailbox("sso-no-amr");
    const cookie = await sessionFor(user);
    const { client, secret } = await application();
    const { sid } = defined(await identityOf(cookie), "the session");

    // A session from before `amr` was kept.
    await db.update(sessions).set({ amr: null }).where(eq(sessions.id, sid));

    const { claims } = await signInTo(cookie, { id: client.id, secret });

    expect(claims.amr).toBeUndefined();
  });
});
