import { defineConfig } from "vitest/config";

// The relay is fetch and WebCrypto alone, so its tests run in Node, with Apple and Google in memory.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
