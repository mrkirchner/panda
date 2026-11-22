import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

// Formatting is Prettier's job; ESLint only checks correctness.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,ts,jsx,tsx}"],
    languageOptions: { globals: { ...globals.browser, __DEV__: "readonly" } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["*.config.js", "devices/deviceConfigPlugin.ts", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
