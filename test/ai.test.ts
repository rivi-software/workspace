import { describe, expect, it } from "vitest";

import { aiEnabled } from "~/lib/ai";

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
});
