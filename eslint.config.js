import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["backend/apps/**/*.ts", "backend/packages/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["backend/apps/mycli/src/node-runtime/**/*.ts", "backend/packages/gateway/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["mycli-shell-tui", "mycli-shell-tui/*"], message: "Use the client-independent @mycli/gateway API." }],
      }],
    },
  },
  { ignores: ["**/dist/**", "**/src/generated/**"] },
);
