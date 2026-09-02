import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * ESLint 配置（flat config）。
 *
 * 上它的唯一理由是 **`react-hooks` 那两条规则**，不是风格统一：
 * 风格问题不会导致线上事故，而 hooks 的依赖/调用顺序问题会——它们的典型症状
 * 是“闭包里拿到陈旧值”，而且 tsc 完全看不出来。本仓库里已经有大量
 * `xxxRef.current = xxx` 的写法，就是在手工绕这类问题。
 *
 * **故意不开的：**
 * - 格式类规则（缩进/引号/分号）——项目没用 Prettier，现在加会凭空改动整个仓库。
 * - `no-explicit-any` 等风格建议——噪声大于收益，且 tsc 严格模式已经在守大头。
 *
 * 一条规则要么由机器把关、要么就会烂掉，所以这里开的每一条都是 error（进门禁），
 * 不用 warn——warn 在 CI 里等于没有。
 */
export default tseslint.config(
  {
    // 只扫手写源码。不限定的话 flat config 会去 lint public/ 里的图标等二进制文件，
    // 报出一堆 "Parsing error: File appears to be binary"。
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/**",
      "src-tauri/**",
      // 生成物（由 scripts/gen-changelog.mjs 写入），不归人管。
      "src/lib/changelog.generated.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // hooks 必须在顶层无条件调用。违反会造成状态错位，无条件 error。
      "react-hooks/rules-of-hooks": "error",
      // 依赖数组不全 → 闭包拿陈旧值。这是本仓库真实踩过的坑类型。
      "react-hooks/exhaustive-deps": "error",

      // 下面两条把 recommended 里的噪声降下去：
      // 项目里大量 `catch { /* 忽略 */ }` 与 `_zone` 这类故意不用的参数是有意设计的。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // tsc 已经在管类型，any 的使用处都是跟 Tauri IPC 边界打交道的地方。
      "@typescript-eslint/no-explicit-any": "off",
      // 代码里的不规则空白是真 bug（能把标识符悄无声息地切开），保留 error；
      // 但**字符串/模板里的是排版**——例如进度条用 U+2003 全角空格拉开
      // 「62%」与「剩余」，是故意的，不能当错报。
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true }],
    },
  },
  {
    // 脚本是 Node 环境，跑在构建/钩子里，不受浏览器规则约束。
    files: ["scripts/**/*.mjs", "*.config.{ts,mjs,js}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
      },
    },
  },
);
