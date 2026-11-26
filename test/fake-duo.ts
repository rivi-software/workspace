/**
 * Duo in memory, for the tests of the Duo sign-in (`test/duo.test.ts`): a `fetch` that answers Duo's health check and
 * token endpoint for one Web SDK application, and `approve` for the step the person takes in Duo's prompt. Ported from
 * the monorepo's `@rivi/sso/testing`; nothing reaches a real Duo.
 */
import { randomToken } from "~/lib/crypto";
import { signHmacJwt, verifyHmacJwt } from "~/lib/duo/hmac-jwt";
import { stringOrNull } from "~/lib/guards";
import type { JwtClaims } from "~/lib/sso/jwt";

interface DuoIssued {
  username: string;
  nonce: string;
  redirectUri: string;
  /** `null`: the ID token carries no `auth_result`. */
  result: "allow" | "deny" | null;
  amr: string[];
  used: boolean;
}

export interface FakeDuo {
  apiHost: string;
  fetch: typeof fetch;
  /** Health checks answer FAIL and the token endpoint 503 while this is on. */
  down: boolean;
  /** The claims of the signed request in an authorize URL the client made (verified with the secret). */
  authorizeRequest: (url: string) => Promise<JwtClaims>;
  /** The person went through the prompt: where Duo sends the browser (the callback with `state` and `duo_code`). */
  approve: (
    url: string,
    options?: {
      result?: "allow" | "deny" | null;
      amr?: string[];
      username?: string;
    }
  ) => Promise<{ code: string; state: string; callbackUrl: string }>;
  calls: { health: number; token: number };
}

export const fakeDuo = (options: {
  clientId: string;
  clientSecret: string;
  apiHost?: string;
}): Promise<FakeDuo> => {
  const apiHost = options.apiHost ?? "api-fake.duosecurity.test";
  const base = `https://${apiHost}`;
  const tokenEndpoint = `${base}/oauth/v1/token`;
  const codes = new Map<string, DuoIssued>();
  const calls = { health: 0, token: 0 };

  const assertionOk = async (assertion: string, audience: string) =>
    !!(await verifyHmacJwt(assertion, options.clientSecret, {
      issuer: options.clientId,
      audience,
    }));

  // oxlint-disable-next-line eslint/complexity -- one request handler: it routes each endpoint of the fake Duo in turn, each checking its own request in order
  const handle = async (
    request: Request,
    current: FakeDuo
  ): Promise<Response> => {
    const url = new URL(request.url);

    if (url.origin !== base || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const form = new URLSearchParams();

    for (const [name, value] of await request.formData()) {
      const text = stringOrNull(value);

      if (text !== null) {
        form.set(name, text);
      }
    }

    if (url.pathname === "/oauth/v1/health_check") {
      calls.health += 1;

      if (
        form.get("client_id") !== options.clientId ||
        !(await assertionOk(form.get("client_assertion") ?? "", url.href))
      ) {
        return Response.json({
          stat: "FAIL",
          code: 40_301,
          message: "Invalid client assertion",
          message_detail: "",
        });
      }

      if (current.down) {
        return Response.json({
          stat: "FAIL",
          code: 40_002,
          message: "Service unavailable",
          message_detail: "down for the test",
        });
      }

      return Response.json({
        stat: "OK",
        response: { timestamp: Math.floor(Date.now() / 1000) },
      });
    }

    if (url.pathname === "/oauth/v1/token") {
      calls.token += 1;

      if (current.down) {
        return Response.json(
          { error: "server_error", error_description: "down" },
          { status: 503 }
        );
      }

      if (
        form.get("grant_type") !== "authorization_code" ||
        form.get("client_assertion_type") !==
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
        !(await assertionOk(form.get("client_assertion") ?? "", tokenEndpoint))
      ) {
        return Response.json(
          { error: "invalid_client", error_description: "bad assertion" },
          { status: 401 }
        );
      }

      const issued = codes.get(form.get("code") ?? "");

      if (
        !issued ||
        issued.used ||
        issued.redirectUri !== form.get("redirect_uri")
      ) {
        return Response.json(
          { error: "invalid_grant", error_description: "unknown or used code" },
          { status: 400 }
        );
      }

      issued.used = true;
      const now = Math.floor(Date.now() / 1000);

      const idToken = await signHmacJwt(
        {
          iss: tokenEndpoint,
          sub: issued.username,
          preferred_username: issued.username,
          aud: options.clientId,
          exp: now + 3600,
          iat: now,
          auth_time: now,
          nonce: issued.nonce,
          ...(issued.amr.length ? { amr: issued.amr } : undefined),
          ...(issued.result
            ? {
                auth_result: {
                  result: issued.result,
                  status: issued.result,
                  status_msg:
                    issued.result === "allow"
                      ? "Login Successful"
                      : "Login Denied",
                },
              }
            : undefined),
          auth_context: {
            factor: "duo_push",
            reason: "user_approved",
            result: "success",
          },
        },
        options.clientSecret
      );

      return Response.json({
        id_token: idToken,
        access_token: randomToken(16),
        expires_in: 3600,
        token_type: "Bearer",
      });
    }

    return new Response("not found", { status: 404 });
  };

  const fake: FakeDuo = {
    apiHost,
    down: false,
    calls,
    fetch: (input, init) => handle(new Request(input, init), fake),
    async authorizeRequest(url) {
      const u = new URL(url);

      if (u.origin + u.pathname !== `${base}/oauth/v1/authorize`) {
        throw new Error(`not Duo's authorize endpoint: ${url}`);
      }

      const claims = await verifyHmacJwt(
        u.searchParams.get("request") ?? "",
        options.clientSecret,
        {
          issuer: options.clientId,
          audience: base,
        }
      );

      if (!claims) {
        throw new Error("the request JWT did not verify");
      }

      if (u.searchParams.get("client_id") !== options.clientId) {
        throw new Error("client_id differs");
      }

      return claims;
    },
    async approve(url, over = {}) {
      const claims = await fake.authorizeRequest(url);
      const code = randomToken(24);
      codes.set(code, {
        username: over.username ?? stringOrNull(claims.duo_uname) ?? "",
        nonce: stringOrNull(claims.nonce) ?? "",
        redirectUri: stringOrNull(claims.redirect_uri) ?? "",
        result: over.result === undefined ? "allow" : over.result,
        amr: over.amr ?? ["mfa", "otp"],
        used: false,
      });
      const state = stringOrNull(claims.state) ?? "";
      const callback = new URL(stringOrNull(claims.redirect_uri) ?? "");
      callback.searchParams.set("state", state);
      callback.searchParams.set(
        claims.use_duo_code_attribute ? "duo_code" : "code",
        code
      );

      return { code, state, callbackUrl: callback.href };
    },
  };

  return Promise.resolve(fake);
};
