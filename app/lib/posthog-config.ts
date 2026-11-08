import { redactSecretPaths } from "@rivi-software/posthog-tanstack-start/browser";
import type { CaptureResult, PostHogConfig, Properties } from "posthog-js";

/**
 * The pages whose address is a credential: a Drive link outside the workspace (`/s/$token`, #2836), which the share
 * dialog and the file page show its creator, and a customer's signing page (`/s/sign/$token`, #2974). PostHog gets
 * them by pattern, from the browser (`before_send`) and from the Worker's exceptions (`setSecretPaths` in
 * `workers/app.ts`). The signing page comes first: `/s/$token` alone reads its "sign" as the token and keeps the real
 * one.
 */
export const SECRET_PATHS = ["/s/sign/$token", "/s/$token"];

const redactTokens = redactSecretPaths(SECRET_PATHS);

/** An address without its query and fragment, which can hold a search term or a mailed link's token. */
export const withoutQuery = (href: string): string => {
  const at = href.search(/[?#]/u);

  return at === -1 ? href : href.slice(0, at);
};

const stripUrls = (
  properties: Properties | undefined
): Properties | undefined => {
  if (!properties) {
    return properties;
  }

  const out: Properties = {};

  for (const [key, value] of Object.entries<unknown>(properties)) {
    out[key] =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a property of a captured event can hold any JSON value: only a string that is a web address is stripped
      typeof value === "string" && /^https?:\/\//u.test(value)
        ? withoutQuery(value)
        : value;
  }

  return out;
};

/**
 * Every address on an event or a person (`$current_url`, `$referrer`, `$initial_current_url`, …) leaves without its
 * query and fragment: Mail's and Drive's search terms ride in the query, and `/reset-password` and
 * `/confirm-recovery` carry their token in the fragment.
 */
export const stripQueries = (
  event: CaptureResult | null
): CaptureResult | null => {
  if (!event) {
    return event;
  }

  return {
    ...event,
    properties: stripUrls(event.properties) ?? {},
    $set: stripUrls(event.$set),
    $set_once: stripUrls(event.$set_once),
  };
};

/**
 * Error tracking only: exceptions and the person they happened to. A page here shows a person's mail and files, so
 * nothing records what is on it or what was clicked (no autocapture, pageviews, heatmaps or session replay).
 * Workspace's people are an organisation's workforce at work; Do Not Track still keeps everything in the browser. A link's
 * public page is someone outside the workspace, so the router never starts PostHog there (`app/router.tsx`).
 */
export const posthogOptions = {
  capture_exceptions: true,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_dead_clicks: false,
  capture_heatmaps: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  // No feature flags here, and the flags request sends the person's first address as it was, past `before_send`.
  advanced_disable_flags: true,
  respect_dnt: true,
  before_send: (event) => {
    const stripped = stripQueries(event);

    return stripped && redactTokens(stripped);
  },
} satisfies Partial<PostHogConfig>;
