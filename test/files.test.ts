import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { signFileUrl, verifyFileSignature } from "~/lib/mail/files.server";

import { defined } from "./fixtures";

describe("signed file links", () => {
  it("verifies its own signature and refuses a changed id, signature or an expired link", async () => {
    const url = new URL(await signFileUrl(env, "att_1", 60), "https://x");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    expect(url.pathname).toBe("/api/files/att_1");
    await expect(
      verifyFileSignature(env, "att_1", exp, sig)
    ).resolves.toBeTruthy();
    const stale = new URL(await signFileUrl(env, "att_1", -10), "https://x");

    const invalidChecks = await Promise.all([
      verifyFileSignature(env, "att_2", exp, sig),
      verifyFileSignature(
        env,
        "att_1",
        exp,
        defined(sig).replace(/.$/u, (c) => (c === "0" ? "1" : "0"))
      ),
      verifyFileSignature(
        env,
        "att_1",
        stale.searchParams.get("exp"),
        stale.searchParams.get("sig")
      ),
      verifyFileSignature(env, "att_1", null, sig),
    ]);

    expect(invalidChecks).toStrictEqual([false, false, false, false]);
  });
});
