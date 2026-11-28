/**
 * Push notifications to the workspace's apps (docs/PUSH.md), off unless `PUSH_RELAY_URL` names a push relay. A
 * signed-in app registers its device with the relay, which answers a Web Push endpoint, and hands that endpoint and
 * keys of its own to the workspace (`subscribe`, `POST /api/v1/push/subscriptions`). When mail reaches the person's
 * inbox, the workspace encrypts a short notice for each of their subscriptions and posts it to the relay, which hands
 * it to Apple or Google unopened (`notifyNewMail`). A subscription is its session's, so whatever ends the session ends
 * its notifications, and one the relay calls gone is forgotten.
 */
import { and, eq, or } from "drizzle-orm";

import type { Database } from "~/db";
import { pushSubscriptions, threads, workspaceSettings } from "~/db/schema";
import type { User } from "~/db/schema";
import { base64UrlDecode } from "~/lib/crypto";
import { errorMessage, parseJsonObject, stringOrNull } from "~/lib/guards";
import { newId } from "~/lib/ids";
import { threadHref } from "~/lib/mail/links";
import { openSecret, sealSecret } from "~/lib/secret-box.server";

import { generateVapidKey, importVapidKey, sendPush } from "./web-push.server";
import type { PushOutcome, VapidKey } from "./web-push.server";

/** A request to subscribe the workspace cannot take, in words for the app's developer. */
export class PushError extends Error {
  override name = "PushError";
}

/** The relay's origin, or null while push is off: `PUSH_RELAY_URL` empty, or no HTTPS address. */
export const pushRelayOrigin = (env: Env): string | null => {
  // SAFETY: `wrangler types` types the var from wrangler.jsonc as the literal "" it holds there; a deployment sets any address.
  const configured = (env.PUSH_RELAY_URL as string).trim();

  if (!configured) {
    return null;
  }

  try {
    const url = new URL(configured);

    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

export const pushEnabled = (env: Env): boolean => pushRelayOrigin(env) !== null;

/** Where an endpoint the relay gives out lives (relay/README.md): any other address is refused. */
const RELAY_PUSH_PATH = "/v1/push/";

const VAPID_SETTING = "push.vapid-key";
const VAPID_PURPOSE = "push-vapid-key";

/** The key as `workspace_settings` keeps it: the public half as it is, the private half sealed. */
const readVapidRow = async (
  db: Database,
  env: Env
): Promise<VapidKey | null> => {
  const row = await db.query.workspaceSettings.findFirst({
    where: eq(workspaceSettings.key, VAPID_SETTING),
  });

  if (!row) {
    return null;
  }

  const stored = parseJsonObject(row.value);
  const publicKey = stringOrNull(stored.publicKey);

  const opened = await openSecret(
    env,
    VAPID_PURPOSE,
    stringOrNull(stored.privateJwk)
  );

  if (!publicKey || !opened) {
    return null;
  }

  try {
    // SAFETY: the sealed text is the JWK `vapidKey` wrote below; a broken one fails the import and counts as none.
    return await importVapidKey(JSON.parse(opened) as JsonWebKey, publicKey);
  } catch {
    return null;
  }
};

/**
 * The workspace's VAPID key, made on first use. A key whose private half no longer opens (`SESSION_SECRET` rotated)
 * is replaced, and every subscription with it: the relay bound each to the old key and would refuse the new one's
 * pushes, so the apps subscribe again when `GET /push` names another key.
 */
export const vapidKey = async (db: Database, env: Env): Promise<VapidKey> => {
  const existing = await readVapidRow(db, env);

  if (existing) {
    return existing;
  }

  const made = await generateVapidKey();

  const value = JSON.stringify({
    publicKey: made.publicKey,
    privateJwk: await sealSecret(
      env,
      VAPID_PURPOSE,
      JSON.stringify(made.privateJwk)
    ),
  });

  const stale = await db.query.workspaceSettings.findFirst({
    where: eq(workspaceSettings.key, VAPID_SETTING),
  });

  if (stale) {
    await db.delete(pushSubscriptions);
    await db
      .update(workspaceSettings)
      .set({ value, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceSettings.key, VAPID_SETTING),
          eq(workspaceSettings.value, stale.value)
        )
      );
  } else {
    // Two isolates may make the first key at once: one row is kept, and both read it back.
    await db
      .insert(workspaceSettings)
      .values({ key: VAPID_SETTING, value })
      .onConflictDoNothing();
  }

  const kept = await readVapidRow(db, env);

  return kept ?? importVapidKey(made.privateJwk, made.publicKey);
};

/** What an app reads before it subscribes (`GET /api/v1/push`): whether push is on, where to register, and the key. */
export const pushSettings = async (db: Database, env: Env) => {
  const relay = pushRelayOrigin(env);

  if (!relay) {
    return { enabled: false as const, relay: null, applicationServerKey: null };
  }

  const { publicKey } = await vapidKey(db, env);

  return { enabled: true as const, relay, applicationServerKey: publicKey };
};

/** A subscription as an app sends it: the shape of a browser's `PushSubscription.toJSON()`. */
export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Whether a base64url key decodes to `bytes` bytes (and, for a public key, an uncompressed P-256 point). */
const keyOf = (value: string, bytes: number): boolean => {
  if (!/^[\w-]+={0,2}$/u.test(value)) {
    return false;
  }

  const decoded = base64UrlDecode(value);

  return decoded.length === bytes && (bytes !== 65 || decoded[0] === 4);
};

/**
 * Keep where the session's app takes its notifications, in place of any it had: one subscription a session, and an
 * endpoint another session held (the app signed in again) moves to this one.
 */
export const subscribe = async (
  db: Database,
  env: Env,
  user: User,
  sessionId: string,
  input: SubscriptionInput
): Promise<{ id: string }> => {
  const relay = pushRelayOrigin(env);

  if (!relay) {
    throw new PushError("Push notifications are off on this workspace.");
  }

  if (
    input.endpoint.length > 2048 ||
    !input.endpoint.startsWith(`${relay}${RELAY_PUSH_PATH}`)
  ) {
    throw new PushError(`The endpoint is not one ${relay} gave out.`);
  }

  if (!keyOf(input.p256dh, 65) || !keyOf(input.auth, 16)) {
    throw new PushError(
      "The keys are a P-256 public key (65 bytes) and a 16-byte auth secret, base64url."
    );
  }

  const id = newId("psh");

  await db.batch([
    db
      .delete(pushSubscriptions)
      .where(
        or(
          eq(pushSubscriptions.sessionId, sessionId),
          eq(pushSubscriptions.endpoint, input.endpoint)
        )
      ),
    db.insert(pushSubscriptions).values({
      id,
      userId: user.id,
      sessionId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    }),
  ]);

  return { id };
};

/** Forget one of the person's subscriptions; false when it is not theirs. */
export const unsubscribe = async (
  db: Database,
  userId: string,
  id: string
): Promise<boolean> => {
  const gone = await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId))
    )
    .returning({ id: pushSubscriptions.id });

  return gone.length > 0;
};

/** What a notification says, as the app opens it (docs/PUSH.md): JSON, a few hundred bytes. */
export interface PushNotice {
  type: "mail";
  title: string;
  body: string;
  threadId: string;
  url: string;
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** VAPID's `sub`: the workspace's address when it is HTTPS, else its postmaster. */
const subjectOf = (env: Env): string =>
  env.APP_URL.startsWith("https://")
    ? new URL(env.APP_URL).origin
    : `mailto:postmaster@${env.MAIL_DOMAIN}`;

/** A notice nobody opened in a day is old news. */
const MAIL_TTL_SECONDS = 24 * 60 * 60;

/** Push `notice` to every subscription of the person; a subscription the relay calls gone is forgotten. */
export const pushToPerson = async (
  env: Env,
  db: Database,
  userId: string,
  notice: PushNotice,
  options: { fetch?: typeof fetch; now?: number; topic?: string } = {}
): Promise<Record<PushOutcome, number>> => {
  const counts: Record<PushOutcome, number> = { sent: 0, gone: 0, failed: 0 };

  if (!pushEnabled(env)) {
    return counts;
  }

  const targets = await db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, userId),
  });

  if (targets.length === 0) {
    return counts;
  }

  const key = await vapidKey(db, env);
  const message = JSON.stringify(notice);

  const outcomes = await Promise.all(
    targets.map(async (target) => ({
      id: target.id,
      outcome: await sendPush(target, message, {
        key,
        subject: subjectOf(env),
        ttl: MAIL_TTL_SECONDS,
        urgency: "normal",
        topic: options.topic,
        fetch: options.fetch ?? fetch,
        now: options.now ?? Date.now(),
      }),
    }))
  );

  for (const { id, outcome } of outcomes) {
    counts[outcome] += 1;

    if (outcome === "gone") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a gone subscription is rare: one delete each
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
    }
  }

  return counts;
};

/**
 * Tell the mailbox's owner about a message that arrived, when it is news: in the inbox, unread, the conversation
 * neither muted nor snoozed. Spam, a filter that archived or read it, and imported history say nothing. A failing
 * relay never fails the delivery: it is logged, and the mail is filed all the same.
 */
export const notifyNewMail = async (
  env: Env,
  db: Database,
  user: User,
  arrived: { threadId: string; from: string; subject: string },
  options: { fetch?: typeof fetch; now?: number } = {}
): Promise<void> => {
  if (!pushEnabled(env) || user.kind !== "person") {
    return;
  }

  try {
    const thread = await db.query.threads.findFirst({
      columns: {
        folder: true,
        muted: true,
        snoozedUntil: true,
        unreadCount: true,
      },
      where: and(eq(threads.id, arrived.threadId), eq(threads.userId, user.id)),
    });

    if (
      thread?.folder !== "inbox" ||
      thread.muted ||
      thread.snoozedUntil ||
      thread.unreadCount === 0
    ) {
      return;
    }

    const counts = await pushToPerson(
      env,
      db,
      user.id,
      {
        type: "mail",
        title: clip(arrived.from || "New mail", 100),
        body: clip(arrived.subject || "(no subject)", 200),
        threadId: arrived.threadId,
        url: `${new URL(env.APP_URL).origin}${threadHref(arrived.threadId)}`,
      },
      // A newer message in the same conversation replaces the notice of one not yet shown.
      { ...options, topic: arrived.threadId.slice(0, 32) }
    );

    if (counts.sent + counts.gone + counts.failed > 0) {
      console.log(
        JSON.stringify({ event: "push.mail", user: user.id, ...counts })
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "push.failed",
        user: user.id,
        error: errorMessage(error),
      })
    );
  }
};
