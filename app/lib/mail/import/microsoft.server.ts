/**
 * Microsoft 365 as a mail source: the Microsoft identity platform's authorization code flow with PKCE for one
 * person's own mailbox (delegated `Mail.Read`, read-only, with `offline_access` for a refresh token), and the
 * Microsoft Graph calls an import makes: who the mailbox is, its folders, its messages oldest first, and each
 * message's original MIME. Exchange Online answers IMAP only with OAuth too, and Outlook exports no mbox, so Graph is
 * the way in. On when `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are set (README, Microsoft 365 import).
 */

import { GraphError } from "./graph-error.server";

export { GraphError } from "./graph-error.server";

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

/** What the connection may do: read mail, know who the mailbox is, and keep going while nobody is signed in. */
export const MICROSOFT_SCOPES = "offline_access User.Read Mail.Read";

/** Where Microsoft sends the browser back; registered on the Entra application as a Web redirect URI. */
export const MICROSOFT_CALLBACK_PATH = "/api/import/microsoft/callback";

export interface MicrosoftTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** The connection is refused or gone (consent withdrawn, password changed, token expired): connect again. */
export class MicrosoftAuthError extends Error {
  override name = "MicrosoftAuthError";
}

export type Fetch = typeof fetch;

export const microsoftConfigured = (env: Env): boolean =>
  !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);

/** The directory the sign-in goes through: the organisation's tenant, or any work account (`organizations`). */
const tenant = (env: Env): string =>
  env.MICROSOFT_TENANT_ID?.trim() || "organizations";

export const microsoftRedirectUri = (env: Env): string =>
  `${env.APP_URL.replace(/\/+$/u, "")}${MICROSOFT_CALLBACK_PATH}`;

/** Microsoft's sign-in and consent page for one connection. */
export const microsoftAuthorizeUrl = (
  env: Env,
  options: { state: string; codeChallenge: string }
): string => {
  const params = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: microsoftRedirectUri(env),
    response_mode: "query",
    scope: MICROSOFT_SCOPES,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    // The person may be signed in to Microsoft as someone else; they choose which mailbox.
    prompt: "select_account",
  });

  return `${LOGIN}/${tenant(env)}/oauth2/v2.0/authorize?${params}`;
};

const retryAfter = (res: Response): number | null => {
  const value = Number(res.headers.get("retry-after"));

  return Number.isFinite(value) && value > 0 ? value : null;
};

const tokenRequest = async (
  env: Env,
  params: Record<string, string>,
  fetcher: Fetch
): Promise<MicrosoftTokens> => {
  const res = await fetcher(`${LOGIN}/${tenant(env)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      scope: MICROSOFT_SCOPES,
      ...params,
    }),
  });

  // SAFETY: the token endpoint answers JSON of this shape, or an error body of it; every field is optional and `access_token` is checked before use.
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !body.access_token) {
    // The first line of Microsoft's description names the problem (AADSTS code and words); the rest is trace ids.
    const why =
      body.error_description?.split(/\r?\n/u)[0] ||
      body.error ||
      `HTTP ${res.status}`;

    if (res.status === 429 || res.status >= 500) {
      throw new GraphError(
        `Microsoft could not be reached: ${why}`,
        res.status,
        retryAfter(res)
      );
    }

    throw new MicrosoftAuthError(`Microsoft refused the connection: ${why}`);
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? params.refresh_token ?? "",
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
};

/** The code Microsoft sent the browser back with, redeemed for the connection's tokens. */
export const exchangeMicrosoftCode = (
  env: Env,
  code: string,
  codeVerifier: string,
  fetcher: Fetch = fetch
): Promise<MicrosoftTokens> =>
  tokenRequest(
    env,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: microsoftRedirectUri(env),
      code_verifier: codeVerifier,
    },
    fetcher
  );

/** New tokens for an access token about to expire. Microsoft rotates the refresh token, so keep the new one. */
export const refreshMicrosoftTokens = (
  env: Env,
  refreshToken: string,
  fetcher: Fetch = fetch
): Promise<MicrosoftTokens> =>
  tokenRequest(
    env,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetcher
  );

// ---------- Microsoft Graph ----------

/** A folder of the source mailbox. `wellKnown` is Graph's name for a folder it knows (`inbox`, `sentitems`, …). */
export interface SourceFolder {
  id: string;
  name: string;
  /** The folder's names from the top, joined by "/". */
  path: string;
  parentId: string | null;
  total: number;
  wellKnown: string | null;
}

/** A message as the list names it, before its MIME is fetched. */
export interface SourceMessage {
  id: string;
  folderId: string;
  receivedAt: string;
  subject: string;
  read: boolean;
  flagged: boolean;
  draft: boolean;
  categories: string[];
  internetMessageId: string | null;
}

/** A mailbox an import reads from. Graph is the one there is; the tests bring their own. */
export interface MailSource {
  account: () => Promise<{ email: string; name: string | null }>;
  folders: () => Promise<SourceFolder[]>;
  /** The messages received at or after `after` (ISO; the oldest when null), oldest first, `skip` of them passed. */
  messages: (
    after: string | null,
    skip: number,
    top: number
  ) => Promise<SourceMessage[]>;
  /** The original message, or why there is none: gone since it was listed, or larger than `maxBytes`. */
  mime: (
    id: string,
    maxBytes: number
  ) => Promise<ArrayBuffer | "gone" | "too-large">;
}

/** The folders Graph names that an import looks up: those it leaves out, and those that say where mail goes. */
export const WELL_KNOWN_FOLDERS = [
  "inbox",
  "sentitems",
  "archive",
  "deleteditems",
  "junkemail",
  "drafts",
  "outbox",
  "conversationhistory",
  "syncissues",
  "conflicts",
  "localfailures",
  "serverfailures",
  "recoverableitemsdeletions",
  "scheduled",
  "searchfolders",
] as const;

const MESSAGE_FIELDS =
  "id,parentFolderId,receivedDateTime,subject,isRead,isDraft,flag,categories,internetMessageId";

const FOLDER_FIELDS =
  "id,displayName,parentFolderId,childFolderCount,totalItemCount";

/** OData's `$` parameters as Graph reads them: the names as they are, the values encoded. */
const odata = (params: Record<string, string | undefined>): string =>
  Object.entries(params)
    .flatMap(([k, v]) =>
      v === undefined ? [] : [`${k}=${encodeURIComponent(v)}`]
    )
    .join("&");

interface GraphFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  totalItemCount?: number;
}

interface GraphMessage {
  id: string;
  parentFolderId: string;
  receivedDateTime: string;
  subject?: string | null;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
  internetMessageId?: string | null;
}

/** Graph for one connection: `token` hands out a valid access token (refreshing it when needed). */
export const graphMailSource = (
  token: () => Promise<string>,
  fetcher: Fetch = fetch
): MailSource => {
  const call = async (
    path: string,
    accept = "application/json"
  ): Promise<Response> => {
    const res = await fetcher(
      path.startsWith("https://") ? path : `${GRAPH}${path}`,
      {
        headers: { authorization: `Bearer ${await token()}`, accept },
      }
    );

    if (res.ok || res.status === 404) {
      return res;
    }

    const text = await res.text().catch(() => "");
    let why = text.slice(0, 200);

    try {
      // SAFETY: Graph's error body is `{ error: { message } }`; a body of another shape reads as absent through `?.`, and `JSON.parse` of text that is not JSON throws into the catch.
      why =
        (JSON.parse(text) as { error?: { message?: string } }).error?.message ??
        why;
    } catch {
      // not JSON: the text as it came
    }

    if (res.status === 401 || res.status === 403) {
      throw new MicrosoftAuthError(
        `Microsoft refused access to the mailbox: ${why}`
      );
    }

    throw new GraphError(
      `Microsoft Graph answered ${res.status}: ${why}`,
      res.status,
      retryAfter(res)
    );
  };

  const json = async <T>(path: string): Promise<T | null> => {
    const res = await call(path);

    // SAFETY: `T` is the shape the caller expects Graph to answer for this path; Graph's answers are not validated.
    return res.status === 404 ? null : ((await res.json()) as T);
  };

  return {
    async account() {
      const me = await json<{
        mail?: string | null;
        userPrincipalName?: string;
        displayName?: string;
      }>(`/me?${odata({ $select: "mail,userPrincipalName,displayName" })}`);

      const email = (me?.mail || me?.userPrincipalName || "").toLowerCase();

      if (!email) {
        throw new MicrosoftAuthError(
          "Microsoft did not say which mailbox this is."
        );
      }

      return { email, name: me?.displayName || null };
    },

    async folders() {
      const wellKnown = new Map<string, string>();

      for (const name of WELL_KNOWN_FOLDERS) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the source pages by cursor and answers in order: each request follows the one before
        const f = await json<{ id: string }>(
          `/me/mailFolders/${name}?${odata({ $select: "id" })}`
        );

        if (f) {
          wellKnown.set(f.id, name);
        }
      }

      const out: SourceFolder[] = [];

      const walk = async (
        first: string,
        parentPath: string,
        parentId: string | null
      ) => {
        for (let next: string | null = first; next;) {
          const page: {
            value?: GraphFolder[];
            "@odata.nextLink"?: string;
            // oxlint-disable-next-line eslint/no-await-in-loop -- the source pages by cursor and answers in order: each request follows the one before
          } | null = await json(next);

          for (const f of page?.value ?? []) {
            const path = parentPath
              ? `${parentPath}/${f.displayName}`
              : f.displayName;

            out.push({
              id: f.id,
              name: f.displayName,
              path,
              parentId,
              total: f.totalItemCount ?? 0,
              wellKnown: wellKnown.get(f.id) ?? null,
            });

            if (f.childFolderCount) {
              // oxlint-disable-next-line eslint/no-await-in-loop -- the source pages by cursor and answers in order: each request follows the one before
              await walk(
                `/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?${odata({ $top: "100", $select: FOLDER_FIELDS })}`,
                path,
                f.id
              );
            }
          }

          next = page?.["@odata.nextLink"] ?? null;
        }
      };

      await walk(
        `/me/mailFolders?${odata({ $top: "100", $select: FOLDER_FIELDS })}`,
        "",
        null
      );

      return out;
    },

    async messages(after, skip, top) {
      // Keyset paging on the received time: it survives mail arriving and moving while the import runs, where
      // Graph's own next links count an offset into a list that changes under them.
      const params = {
        $select: MESSAGE_FIELDS,
        $orderby: "receivedDateTime asc",
        $top: String(top),
        $filter: after ? `receivedDateTime ge ${after}` : undefined,
        $skip: skip ? String(skip) : undefined,
      };

      const page = await json<{ value?: GraphMessage[] }>(
        `/me/messages?${odata(params)}`
      );

      return (page?.value ?? []).map((m) => ({
        id: m.id,
        folderId: m.parentFolderId,
        receivedAt: m.receivedDateTime,
        subject: m.subject ?? "",
        read: !!m.isRead,
        flagged: m.flag?.flagStatus === "flagged",
        draft: !!m.isDraft,
        categories: m.categories ?? [],
        internetMessageId: m.internetMessageId ?? null,
      }));
    },

    async mime(id, maxBytes) {
      const res = await call(
        `/me/messages/${encodeURIComponent(id)}/$value`,
        "*/*"
      );

      if (res.status === 404) {
        return "gone";
      }

      if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
        await res.body?.cancel();

        return "too-large";
      }

      if (!res.body) {
        return new ArrayBuffer(0);
      }

      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body.getReader();

      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the source pages by cursor and answers in order: each request follows the one before
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        size += value.byteLength;

        if (size > maxBytes) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- the source pages by cursor and answers in order: each request follows the one before
          await reader.cancel();

          return "too-large";
        }

        chunks.push(value);
      }

      const out = new Uint8Array(size);
      let at = 0;

      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }

      return out.buffer;
    },
  };
};
