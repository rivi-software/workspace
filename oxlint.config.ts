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
  // The rules that need the types (oxlint-tsgolint): a promise nobody awaits, a promise where a boolean or a
  // callback's return goes, and the like.
  options: { typeAware: true },
  // Of those, the ones that only ask for another way to write what is already right stay off: the code reads a
  // string's or a number's truthiness on purpose (`||` and `if (x)` on an empty string), and an arrow returns what a
  // one-line call answers.
  rules: {
    // An effect's early `return;` beside its cleanup is React's own shape, and `return undefined;`, the one way to
    // satisfy this rule, is what `unicorn/no-useless-undefined` takes out again.
    "typescript/consistent-return": "off",
    "typescript/no-confusing-void-expression": "off",
    "typescript/no-unnecessary-type-conversion": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/prefer-regexp-exec": "off",
    "typescript/promise-function-async": "off",
    "typescript/return-await": "off",
    "typescript/strict-boolean-expressions": "off",
    // TanStack's `redirect()` and `notFound()`, and a Response, are thrown on purpose: the router and Start catch them.
    "typescript/only-throw-error": [
      "error",
      {
        allow: [
          { from: "lib", name: "Response" },
          {
            from: "package",
            name: ["NotFoundError", "Redirect"],
            package: "@tanstack/router-core",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // Plain JavaScript that no tsconfig checks: what a JSON, a catch or a child process hands it is `any`.
      files: ["scripts/**"],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
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
