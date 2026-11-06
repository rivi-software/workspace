import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import drizzle from "ultracite/oxlint/drizzle";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  env: core.env,
  extends: [core, react, tanstack, vitest, antiSlop, drizzle],
  ignorePatterns: [
    ...core.ignorePatterns,
    "docs/**",
    "migrations/**",
    "public/**",
    "seed/**",
  ],
  overrides: [
    {
      files: ["app/routes/__root.tsx"],
      rules: {
        "react/no-danger": "off",
      },
    },
    {
      files: ["app/components/drive/preview.tsx"],
      rules: {
        "jsx-a11y/media-has-caption": "off",
      },
    },
  ],
  settings: {
    "jsx-a11y": {
      components: { Checkbox: "input" },
    },
  },
});
