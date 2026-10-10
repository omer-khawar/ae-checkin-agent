// ESLint flat config (ESLint 9) for the Interim web app.
// typescript-eslint recommended + React hooks rules + react-refresh HMR hygiene.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "*.config.js"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Hooks that belong with their provider (useToast) are allowed by name.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true, allowExportNames: ["useToast"] },
      ],
      // Prefer `import type` so the bundler can drop type-only imports.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Library modules legitimately export hooks/helpers next to a small component
    // (e.g. format.tsx exports <Time/> and formatting functions). The react-refresh
    // rule is an HMR optimisation, not a correctness rule, so it is off here.
    files: ["src/lib/**/*.{ts,tsx}", "src/test/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
