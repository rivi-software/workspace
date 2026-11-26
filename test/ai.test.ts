import { describe, expect, it } from "vitest";

import { aiEnabled } from "~/lib/ai";
import { assistantReady } from "~/lib/assistant/provider.server";

import { stubEnv } from "./stub-env";

const read = (value: string | undefined) =>
  aiEnabled(stubEnv({ AI_FEATURES: value }));

describe("AI_FEATURES", () => {
  it("is on unless it says off", () => {
    expect([
      read(undefined),
      read("on"),
      read(""),
      read("yes"),
      read("off"),
      read(" OFF "),
    ]).toStrictEqual([true, true, true, true, false, false]);
  });

  it("leaves Mail's summary and draft no model while it is off", () => {
    const mock = { AI_PROVIDER: "mock" };

    expect([
      assistantReady(stubEnv({ ...mock, AI_FEATURES: "on" })),
      assistantReady(stubEnv({ ...mock, AI_FEATURES: "off" })),
    ]).toStrictEqual([true, false]);
  });
});
