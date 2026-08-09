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
  { ignores: ["**/dist/**", "**/src/generated/**"] },
);
