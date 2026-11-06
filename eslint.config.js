import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "packages/**/*.ts"],
    languageOptions: { parserOptions: { project: "./tsconfig.json" } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: [
      "src/ui/**/*.ts",
      "src/ui/**/*.tsx",
      "tests/message-markdown.test.ts",
    ],
    languageOptions: {
      parserOptions: { project: "./tsconfig.renderer.json" },
    },
  },
  {
    files: ["src/ui/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/app/**"],
              message: "业务模块通过参数和回调与应用层交互，不反向依赖 app。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/ui/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/app/**", "**/features/**"],
              message: "公共组件只能依赖其他公共组件、lib 和共享契约。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/ui/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/app/**", "**/features/**", "**/components/**"],
              message: "公共基础能力不能依赖应用层、业务模块或 UI 组件。",
            },
          ],
        },
      ],
    },
  },
  // Electron loads this helper as CommonJS before the app is ready.
  {
    files: ["src/desktop/entry.cjs", "src/platform/safe-storage-host.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
