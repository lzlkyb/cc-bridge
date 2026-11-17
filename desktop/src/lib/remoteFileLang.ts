/**
 * 远程文件名 → CodeMirror 语言扩展的映射（纯函数，可单测）。
 *
 * 为什么按扩展名而不是按 shebang：列目录只拿得到名字，读文件才知道第一行，
 * 而为「编辑器高亮」多跑一次远端读取不划算。绝大多数服务器文件按扩展名
 * 判就够准；shell 脚本常无扩展名，用 basename（`Dockerfile`/`Makefile`）兜一层。
 *
 * 映射不到时返回空数组 = CodeMirror 纯文本模式，不报错也不卡编辑。
 */
import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
// legacy-modes 按子路径导入，vite 只打包用到的那几个 mode。
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";

const stream = (mode: StreamParser<unknown>) => StreamLanguage.define(mode);

/** 扩展名（不含点）→ 语言扩展。 */
const BY_EXT: Record<string, Extension> = {
  js: javascript(),
  mjs: javascript(),
  cjs: javascript(),
  jsx: javascript({ jsx: true }),
  ts: javascript({ typescript: true }),
  tsx: javascript({ typescript: true, jsx: true }),
  json: json(),
  py: python(),
  rs: rust(),
  html: html(),
  htm: html(),
  vue: html(),
  css: css(),
  scss: css(),
  less: css(),
  md: markdown(),
  markdown: markdown(),
  yml: yaml(),
  yaml: yaml(),
  sql: sql(),
  xml: xml(),
  svg: xml(),
  go: go(),
  java: java(),
  kt: java(),
  c: cpp(),
  h: cpp(),
  cc: cpp(),
  cpp: cpp(),
  hpp: cpp(),
  php: php(),
  sh: stream(shellMode),
  bash: stream(shellMode),
  zsh: stream(shellMode),
  toml: stream(toml),
  ini: stream(properties),
  cfg: stream(properties),
  conf: stream(nginx),
  env: stream(properties),
  properties: stream(properties),
};

/** 无扩展名的常见文件名 → 语言扩展。 */
const BY_NAME: Record<string, Extension> = {
  Dockerfile: stream(dockerFile),
  Makefile: stream(shellMode),
  "makefile": stream(shellMode),
  ".env": stream(properties),
  ".bashrc": stream(shellMode),
  ".zshrc": stream(shellMode),
  ".profile": stream(shellMode),
};

/** 从远程路径取 basename（兼容 `/` 与 Windows 侧误传的 `\`）。 */
export function baseName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** 扩展名（小写、不含点）；没有则空串。 */
export function extName(remotePath: string): string {
  const name = baseName(remotePath);
  const dot = name.lastIndexOf(".");
  // 前导点文件（.env）不算扩展名
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 取该文件的语言扩展；未知返回 `[]`（纯文本）。
 * `EXT_NAMES` / `LANG_LABELS` 供测试与 UI 展示共用，避免两处漂移。
 */
export function languageFor(remotePath: string): Extension[] {
  const name = baseName(remotePath);
  if (BY_NAME[name]) return [BY_NAME[name]];
  const ext = extName(remotePath);
  if (ext && BY_EXT[ext]) return [BY_EXT[ext]];
  return [];
}

/** 该扩展是否有高亮（UI 用：无高亮时状态栏不显示「纯文本」噪音）。 */
export function hasHighlight(remotePath: string): boolean {
  return languageFor(remotePath).length > 0;
}
