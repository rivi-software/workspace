import type { Database } from "~/db";
/**
 * Connecting a Microsoft 365 mailbox for an import: `/api/import/microsoft/start` sends the signed-in person to
 * Microsoft's sign-in and consent page, with the state and the PKCE verifier sealed into a cookie on
 * `/api/import/microsoft` (no server-side record). `/api/import/microsoft/callback` checks that
 * cookie belongs to the same person and the same state, then redeems the code and starts the import. Either way the
 * browser lands back on Settings → Mail, with `connect` saying how it went.
 */
import {
  createSignInTransaction,
  openTransaction,
  sealTransaction,
} from "~/lib/sealed";

import { getSessionUser, readCookie } from "../../auth.server";
import { ImportError, startImport } from "./import.server";
import {
  GraphError,
  MicrosoftAuthError,
  exchangeMicrosoftCode,
  microsoftAuthorizeUrl,
  microsoftConfigured,
} from "./microsoft.server";
import type { Fetch, MailSource, MicrosoftTokens } from "./microsoft.server";

const COOKIE = "workspace_ms_import";
const COOKIE_PATH = "/api/import/microsoft";

/** How a connection ended, for the notice in Settings → Mail. */
export type ConnectOutcome =
  | "started"
  | "declined"
  | "expired"
  | "failed"
  | "unavailable";

const redirect = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
  });

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
};

const back = (
  outcome: ConnectOutcome,
  reason?: string,
  cookies: string[] = []
): Response => {
  const params = new URLSearchParams({ tab: "mail", connect: outcome });

  if (reason) {
    params.set("reason", reason.slice(0, 300));
  }

  return redirect(`/settings?${params}`, cookies);
};

const signIn = (): Response =>
  redirect(`/login?${new URLSearchParams({ next: "/settings?tab=mail" })}`);

/** `GET /api/import/microsoft/start`: off to Microsoft, to choose the mailbox and allow reading it. */
export const startMicrosoftConnect = async (
  request: Request,
  env: Env,
  db: Database
): Promise<Response> => {
  const user = await getSessionUser(request, env, db);

  if (!user) {
    return signIn();
  }

  if (!microsoftConfigured(env)) {
    return back("unavailable");
  }

  // The transaction's `next` names the person, so the callback only goes on for whoever started it.
  const { codeChallenge, ...tx } = await createSignInTransaction(user.id);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const cookie = `${COOKIE}=${await sealTransaction(env.SESSION_SECRET, tx)}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;

  return redirect(
    microsoftAuthorizeUrl(env, { state: tx.state, codeChallenge }),
    [cookie]
  );
};

/**
 * `GET /api/import/microsoft/callback?code=…&state=…`: the code redeemed and the import started, or Settings told
 * why not (the person said no, the link was stale or someone else's, Microsoft refused).
 */
export const finishMicrosoftConnect = async (
  request: Request,
  env: Env,
  db: Database,
  options: {
    fetch?: Fetch;
    source?: (tokens: MicrosoftTokens) => MailSource;
  } = {}
): Promise<Response> => {
  const user = await getSessionUser(request, env, db);

  if (!user) {
    return signIn();
  }

  const url = new URL(request.url);
  const clear = `${COOKIE}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`;

  const tx = await openTransaction(
    env.SESSION_SECRET,
    readCookie(request, COOKIE)
  );

  if (
    !tx ||
    tx.next !== user.id ||
    url.searchParams.get("state") !== tx.state
  ) {
    return back("expired", undefined, [clear]);
  }

  const error = url.searchParams.get("error");

  if (error) {
    const why =
      url.searchParams.get("error_description")?.split(/\r?\n/u)[0] ?? error;

    return back(error === "access_denied" ? "declined" : "failed", why, [
      clear,
    ]);
  }

  const code = url.searchParams.get("code");

  if (!code) {
    return back("failed", "Microsoft sent no code back.", [clear]);
  }

  try {
    const tokens = await exchangeMicrosoftCode(
      env,
      code,
      tx.codeVerifier,
      options.fetch
    );

    await startImport(env, db, user, tokens, options.source?.(tokens));

    return back("started", undefined, [clear]);
  } catch (connectError) {
    if (
      connectError instanceof ImportError ||
      connectError instanceof MicrosoftAuthError ||
      connectError instanceof GraphError
    ) {
      return back("failed", connectError.message, [clear]);
    }

    throw connectError;
  }
};
