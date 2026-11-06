import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";

import {
  posthogOptions,
  stripQueries,
  withoutQuery,
} from "~/lib/posthog-config";

const exception = (url: string) =>
  ({
    uuid: "u",
    event: "$exception",
    properties: { $current_url: url },
  }) satisfies CaptureResult;

describe("PostHog in the browser", () => {
  it("tracks errors and nothing of what a page shows or what was clicked", () => {
    expect(posthogOptions).toMatchObject({
      capture_exceptions: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      respect_dnt: true,
    });
  });

  it("sends every address without its query and fragment", () => {
    expect({
      "https://workspace.rivi.software/mail?q=invoice+acme": withoutQuery(
        "https://workspace.rivi.software/mail?q=invoice+acme"
      ),
      "https://workspace.rivi.software/reset-password#tok": withoutQuery(
        "https://workspace.rivi.software/reset-password#tok"
      ),
    }).toStrictEqual({
      "https://workspace.rivi.software/mail?q=invoice+acme":
        "https://workspace.rivi.software/mail",
      "https://workspace.rivi.software/reset-password#tok":
        "https://workspace.rivi.software/reset-password",
    });

    const event = {
      uuid: "u",
      event: "$exception",
      properties: {
        $current_url: "https://workspace.rivi.software/drive?q=salaries#x",
        $referrer: "https://example.com/page?ref=mail",
        $pathname: "/drive",
        $exception_list: [{ type: "TypeError", value: "x is undefined" }],
      },
      $set: { $current_url: "https://workspace.rivi.software/mail?q=a" },
      $set_once: {
        $initial_current_url:
          "https://workspace.rivi.software/confirm-recovery#tok",
      },
    } satisfies CaptureResult;

    const sent = stripQueries(event);
    expect({
      properties: sent?.properties,
      $set: sent?.$set,
      $set_once: sent?.$set_once,
      stripQueries: stripQueries(null),
    }).toStrictEqual({
      properties: {
        $current_url: "https://workspace.rivi.software/drive",
        $referrer: "https://example.com/page",
        $pathname: "/drive",
        $exception_list: [{ type: "TypeError", value: "x is undefined" }],
      },
      $set: {
        $current_url: "https://workspace.rivi.software/mail",
      },
      $set_once: {
        $initial_current_url:
          "https://workspace.rivi.software/confirm-recovery",
      },
      stripQueries: null,
    });
  });

  it("never sends the token of a link or a signing page", () => {
    const send = posthogOptions.before_send;
    const token = "AbC-123_xyz";
    expect(
      send(exception(`https://workspace.rivi.software/s/${token}`))?.properties
    ).toStrictEqual({
      $current_url: "https://workspace.rivi.software/s/$token",
    });

    const sent = send(
      exception(`https://workspace.rivi.software/s/sign/${token}/document`)
    );

    expect(JSON.stringify(sent)).not.toContain(token);
    expect(sent?.properties.$current_url).toMatch(
      /^https:\/\/workspace\.rivi\.software\/s\/.*\/document$/u
    );
  });
});
