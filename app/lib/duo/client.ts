/**
 * Duo as the second factor of a password sign-in: the Universal Prompt through Duo's OIDC Auth API
 * (https://duo.com/docs/oauthapi). After the password checks out, the app sends the browser to Duo with a
 * signed request naming the person; Duo sends it back with a code; the app redeems the code and verifies the
 * ID token Duo signs with the shared client secret. The challenge in flight travels in a sealed cookie, so the
 * app keeps no record of it and KV's eventual consistency never loses one. From `@rivi/sso` in the RIVI monorepo;
 * the Worker's glue is `app/lib/duo.server.ts`.
 */
import { randomToken } from "~/lib/crypto";
import { isJsonObject } from "~/lib/guards";
import { openSealed, seal } from "~/lib/sealed";
import type { JwtClaims } from "~/lib/sso/jwt";

import { DuoError } from "./error";
import { signHmacJwt, verifyHmacJwt } from "./hmac-jwt";

export { DuoError } from "./error";

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

/** A response's body as an object whose members can be read by name; `null` when it is no JSON object. */
const readJsonObject = async (
  body: Pick<Response, "json">
): Promise<JwtClaims | null> => {
  const value: unknown = await body.json().catch(() => null);

  return isJsonObject(value) ? value : null;
};

export interface DuoOptions {
  /** The Web SDK application's Client ID (20 characters). */
  clientId: string;
  /** Its Client secret (40 characters). */
  clientSecret: string;
  /** Its API hostname, `api-xxxxxxxx.duosecurity.com`. */
  apiHost: string;
  /** Where Duo sends the browser back to, with `state` and `duo_code`. */
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface DuoResult {
  /** The Duo username the prompt was for. */
  username: string;
  /** RFC 8176 methods Duo reports (`mfa`, `otp`, …); empty when a policy let the person through. */
  amr: string[];
  /** Seconds since the epoch of the last interactive Duo authentication. */
  authTime: number | null;
  claims: JwtClaims;
}

const JWT_TTL_SECONDS = 5 * 60;
const USER_AGENT = "rivi-sso/1.0 (Cloudflare Workers)";

export class DuoClient {
  readonly clientId: string;
  readonly apiHost: string;
  readonly redirectUri: string;
  private readonly clientSecret: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(options: DuoOptions) {
    if (options.clientId.length !== 20) {
      throw new DuoError("config", "The Duo client id has 20 characters.");
    }

    if (options.clientSecret.length !== 40) {
      throw new DuoError("config", "The Duo client secret has 40 characters.");
    }

    if (!/^[a-z0-9.-]+$/iu.test(options.apiHost)) {
      throw new DuoError(
        "config",
        "The Duo API host is a hostname, without a scheme."
      );
    }

    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.apiHost = options.apiHost;
    this.redirectUri = options.redirectUri;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  get baseUrl(): string {
    return `https://${this.apiHost}`;
  }
  get tokenEndpoint(): string {
    return `${this.baseUrl}/oauth/v1/token`;
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /** The JWT that authenticates this client to Duo's own endpoints (`aud` names the endpoint). */
  private clientAssertion(audience: string): Promise<string> {
    const iat = this.seconds();

    return signHmacJwt(
      {
        iss: this.clientId,
        sub: this.clientId,
        aud: audience,
        jti: randomToken(27),
        iat,
        exp: iat + JWT_TTL_SECONDS,
      },
      this.clientSecret
    );
  }

  private post(
    endpoint: string,
    form: Record<string, string>
  ): Promise<Response> {
    return this.fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams(form),
    });
  }

  /** Whether Duo can take a sign-in now; a `false` answer carries Duo's reason. */
  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const res = await this.post("/oauth/v1/health_check", {
        client_id: this.clientId,
        client_assertion: await this.clientAssertion(
          `${this.baseUrl}/oauth/v1/health_check`
        ),
      });

      const body = await readJsonObject(res);

      if (body?.stat === "OK") {
        return { ok: true };
      }

      return {
        ok: false,
        reason:
          [body?.message, body?.message_detail].filter(Boolean).join(": ") ||
          `HTTP ${res.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Where to send the browser: the Universal Prompt for `username`, with `state` (16 to 1024 characters) and a nonce. */
  async authUrl(input: {
    username: string;
    state: string;
    nonce: string;
    /** Shown in Duo Mobile beside the request. */
    displayName?: string;
  }): Promise<string> {
    if (!input.username) {
      throw new DuoError("username", "A Duo username is needed.");
    }

    if (input.state.length < 16 || input.state.length > 1024) {
      throw new DuoError("state", "The state has 16 to 1024 characters.");
    }

    const exp = this.seconds() + JWT_TTL_SECONDS;

    const request = await signHmacJwt(
      {
        response_type: "code",
        scope: "openid",
        exp,
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        state: input.state,
        nonce: input.nonce,
        duo_uname: input.username,
        iss: this.clientId,
        aud: this.baseUrl,
        use_duo_code_attribute: true,
        ...(input.displayName
          ? { display_username: input.displayName }
          : undefined),
      },
      this.clientSecret
    );

    const query = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      request,
      redirect_uri: this.redirectUri,
      scope: "openid",
    });

    return `${this.baseUrl}/oauth/v1/authorize?${query}`;
  }

  /** Redeems the `duo_code` the browser brought back; the ID token must name `username` and the nonce. */
  // oxlint-disable-next-line eslint/complexity -- one redemption: its checks run in order and each refuses with its own DuoError code
  async exchange(input: {
    code: string;
    username: string;
    nonce: string;
  }): Promise<DuoResult> {
    if (!input.code) {
      throw new DuoError("missing_code", "Duo sent no code back.");
    }

    const res = await this.post("/oauth/v1/token", {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await this.clientAssertion(this.tokenEndpoint),
    });

    const body = await readJsonObject(res);

    if (
      !res.ok ||
      !body ||
      !isString(body.id_token) ||
      body.token_type !== "Bearer"
    ) {
      throw new DuoError(
        isString(body?.error) ? body.error : "token_exchange_failed",
        [body?.error_description ?? body?.message, body?.message_detail]
          .filter(Boolean)
          .join(": ") || `Duo's token endpoint answered ${res.status}.`
      );
    }

    const claims = await verifyHmacJwt(body.id_token, this.clientSecret, {
      issuer: this.tokenEndpoint,
      audience: this.clientId,
      now: this.now(),
    });

    if (!claims || !isNumber(claims.exp) || !isNumber(claims.iat)) {
      throw new DuoError("invalid_id_token", "Duo's ID token did not verify.");
    }

    if (claims.preferred_username !== input.username) {
      throw new DuoError(
        "username_mismatch",
        "Duo's ID token names another person."
      );
    }

    if (claims.nonce !== input.nonce) {
      throw new DuoError(
        "nonce_mismatch",
        "Duo's ID token answers another challenge."
      );
    }

    // Only an explicit `allow` lets the person through: a token without a result is no approval.
    const authResult = claims.auth_result;
    const result = isJsonObject(authResult) ? authResult.result : undefined;

    if (result !== "allow") {
      throw new DuoError(
        "denied",
        `Duo did not allow the sign-in (${isString(result) ? result : "no result"}).`
      );
    }

    return {
      username: input.username,
      amr: Array.isArray(claims.amr)
        ? claims.amr.filter((v): v is string => isString(v))
        : [],
      authTime: isNumber(claims.auth_time) ? claims.auth_time : null,
      claims,
    };
  }
}

// ---------- the challenge in flight, for an app's sign-in route ----------

/** What the sign-in needs back after Duo: the person, and where to go next. */
export interface DuoCarry {
  userId: string;
  next: string;
  /** The session this browser had, which a fresh sign-in for an application (`prompt=login`) replaces. */
  replaces?: string | null;
}

export interface DuoChallenge {
  state: string;
  nonce: string;
  username: string;
  /** What the app needs back after Duo: the person, where to go next. */
  carry: DuoCarry;
  issuedAt: number;
}

export interface DuoCookie {
  name: string;
  path: string;
  secure: boolean;
}

const CHALLENGE_MAX_AGE_SECONDS = JWT_TTL_SECONDS;
const CHALLENGE_PURPOSE = "duo-challenge";

const challengeCookie = (
  cookie: DuoCookie,
  value: string,
  maxAge: number
): string =>
  `${cookie.name}=${value}; Path=${cookie.path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookie.secure ? "; Secure" : ""}`;

/** Sends the browser to Duo for `username`, with the challenge sealed into a cookie on the callback path. */
export const startDuoChallenge = async (
  duo: DuoClient,
  input: {
    secret: string;
    username: string;
    displayName?: string;
    carry: DuoCarry;
    cookie: DuoCookie;
  }
): Promise<Response> => {
  const challenge: DuoChallenge = {
    state: randomToken(27),
    nonce: randomToken(27),
    username: input.username,
    carry: input.carry,
    issuedAt: Date.now(),
  };

  const location = await duo.authUrl({
    username: input.username,
    state: challenge.state,
    nonce: challenge.nonce,
    displayName: input.displayName,
  });

  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
  });

  headers.append(
    "Set-Cookie",
    challengeCookie(
      input.cookie,
      await seal(input.secret, CHALLENGE_PURPOSE, challenge),
      CHALLENGE_MAX_AGE_SECONDS
    )
  );

  return new Response(null, { status: 302, headers });
};

export type DuoOutcome =
  | { ok: true; carry: DuoCarry; result: DuoResult; clearCookie: string }
  | {
      ok: false;
      reason: "no_challenge" | "state_mismatch" | "missing_code" | "duo";
      error?: DuoError;
      clearCookie: string;
    };

const cookieValue = (request: Request, name: string): string | null => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");

    if (k === name) {
      return decodeURIComponent(v.join("="));
    }
  }

  return null;
};

/** The callback: matches the sealed challenge with what Duo sent back and redeems the code. */
export const finishDuoChallenge = async (
  duo: DuoClient,
  input: { secret: string; request: Request; cookie: DuoCookie }
): Promise<DuoOutcome> => {
  const clearCookie = challengeCookie(input.cookie, "", 0);

  const challenge = await openSealed<DuoChallenge>(
    input.secret,
    CHALLENGE_PURPOSE,
    cookieValue(input.request, input.cookie.name),
    { maxAgeSeconds: CHALLENGE_MAX_AGE_SECONDS }
  );

  if (
    !challenge ||
    !isString(challenge.state) ||
    !isString(challenge.username)
  ) {
    return { ok: false, reason: "no_challenge", clearCookie };
  }

  const url = new URL(input.request.url);

  if (url.searchParams.get("state") !== challenge.state) {
    return { ok: false, reason: "state_mismatch", clearCookie };
  }

  const code = url.searchParams.get("duo_code") ?? url.searchParams.get("code");

  if (!code) {
    return { ok: false, reason: "missing_code", clearCookie };
  }

  try {
    const result = await duo.exchange({
      code,
      username: challenge.username,
      nonce: challenge.nonce,
    });

    return { ok: true, carry: challenge.carry, result, clearCookie };
  } catch (error) {
    return {
      ok: false,
      reason: "duo",
      error:
        error instanceof DuoError
          ? error
          : new DuoError("unknown", String(error)),
      clearCookie,
    };
  }
};
