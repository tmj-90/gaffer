// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Flat config (ESLint 9/10).
 *
 * Goals for this baseline:
 *   - Catch real bugs (unused vars, fallthroughs) without fighting the existing,
 *     already-clean codebase.
 *   - NOT type-checked linting (recommended, not recommended-type-checked) — too
 *     slow for a 100+ file monorepo on every pre-commit and CI run.
 *   - Defer ALL formatting to Prettier via eslint-config-prettier.
 */
export default tseslint.config(
  {
    // Global ignores — must be the only key in this object to apply repo-wide.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      // Vendored browser SPA — plain ES module, not part of the TS program.
      // Linted with browser globals in the dedicated override below.
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    // The TypeScript packages run on Node. Give the whole tree Node globals so
    // `process`, `console`, `Buffer`, timers, etc. are recognised.
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // Project-wide TypeScript/JS rule tuning.
    rules: {
      // Allow intentionally-unused args/vars prefixed with `_` (common in
      // callback signatures and destructuring rest patterns here).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // `{}` and empty blocks appear in legitimate no-op branches / option
      // defaults; allow empty catch only when annotated.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  {
    // The dashboard SPA runs in the browser, not Node, and is hand-authored
    // ES (no TS). Give it browser globals and relax the project TS rules.
    files: ["packages/dispatch/src/api/web/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        console: "readonly",
        location: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        EventSource: "readonly",
        CustomEvent: "readonly",
        history: "readonly",
        requestAnimationFrame: "readonly",
        MutationObserver: "readonly",
      },
    },
  },

  {
    // Test code (vitest TS suites + the runner's zero-dependency .mjs harness).
    // These legitimately use patterns the strict baseline forbids in src:
    //   - `any` casts to reach into internals / stub partial shapes
    //   - `require()` for dynamic/lazy module loading under test
    //   - ternary-as-statement (`cond ? ok() : fail()`) in the hand-rolled
    //     assertion harness, which trips no-unused-expressions
    files: [
      "**/test/**",
      "**/*.test.ts",
      "**/*.test.mjs",
      "packages/*/scripts/**",
      "packages/dispatch/test/fixtures/**",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
