import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    "**/*.md",
    "**/*.json",
    "**/*.jsonc",
    "**/*.html",
    "**/public/**",
    "**/worker-configuration.d.ts",
    "**/routeTree.gen.ts",
    "migrations/**",
  ],
});
