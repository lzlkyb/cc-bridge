#!/usr/bin/env node
/**
 * gen-changelog.mjs
 * 构建/开发前自动把根目录 CHANGELOG.md（Keep a Changelog）解析为
 * desktop/src/lib/changelog.generated.ts 的 CHANGELOG 常量，供关于页「更新历史」渲染。
 *
 * 设计原则：CHANGELOG.md 是更新历史的唯一手写源。此脚本消除 about.ts 里
 * 手写 TS 数组「双份维护、经常漏写版本」的痛点（如曾落后到 2.2.17）。
 *
 * 每次 `npm run dev` / `npm run build` 前自动执行（package.json 的 predev/prebuild 钩子，
 * 与 sync-version.mjs 并列）。分类映射集中此处：
 *   新增→feat  变更→improve  修复→fix  安全→sec
 *   技术/依赖/测试/说明→improve（按约定并入「改进」）
 *
 * 生成文件 changelog.generated.ts 由本脚本全权拥有，请勿手改。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // desktop/
const CHANGELOG_PATH = path.join(ROOT, "..", "CHANGELOG.md"); // 项目根
const OUT_PATH = path.join(ROOT, "src", "lib", "changelog.generated.ts");

// 生成最近 N 个版本（其余由关于页折叠区「查看更多版本」按需，但只生成近期避免过长）。
const MAX_ENTRIES = 10;

// CHANGELOG.md 的 ### 小节 → about.ts 的 4 类（ChangeCategory）
const SECTION_MAP = {
  "新增": "feat",
  "变更": "improve",
  "修复": "fix",
  "安全": "sec",
  "技术": "improve",
  "依赖": "improve",
  "测试": "improve",
  "说明": "improve",
};

function fail(msg) {
  console.error(`\x1b[31m[GEN-CHANGELOG ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[GEN-CHANGELOG]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[GEN-CHANGELOG OK]\x1b[0m ${msg}`);
}

if (!fs.existsSync(CHANGELOG_PATH)) {
  fail(`找不到 CHANGELOG.md: ${CHANGELOG_PATH}`);
}

const md = fs.readFileSync(CHANGELOG_PATH, "utf-8");
// 兼容 CRLF / LF（CHANGELOG.md 可能带 \r），否则 `.` 不匹配合 \r 导致小节/条目正则失败。
const lines = md.split(/\r?\n/);

/** 清洗单条文本：去 **加粗**、[text](url)→text，保留 `code` 反引号与中文。 */
function cleanText(raw) {
  return raw
    .replace(/\*\*/g, "") // 去加粗标记
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // markdown 链接 → 纯文字
    .replace(/\s+/g, " ") // 续行/多余空白压成单空格
    .trim();
}

/** 语义版本比较（降序）：a>b 返回正数。CHANGELOG.md 物理顺序未必严格倒序。 */
function compareVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

const entries = [];
let current = null; // { version, date, items: [{category, text}], highlights: string[] }
let currentCategory = null; // 当前 ### 小节映射出的类
let currentItem = null; // 正在累积的多行条目
let mode = "items"; // "items" | "highlights"
let currentHighlight = null; // 正在累积的多行亮点

for (const line of lines) {
  // 版本标题：## [2.2.22] - 2026-07-11
  const verMatch = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(\S+)/);
  if (verMatch) {
    if (current) {
      if (currentItem) current.items.push(currentItem);
      if (currentHighlight !== null) current.highlights.push(currentHighlight);
      entries.push(current);
    }
    current = { version: verMatch[1], date: verMatch[2], items: [], highlights: [] };
    currentCategory = null;
    currentItem = null;
    currentHighlight = null;
    mode = "items";
    continue;
  }

  // 小节标题：### 新增 / ### 变更 / ### 技术 / ### 亮点 ...
  const secMatch = line.match(/^###\s+(.+)$/);
  if (secMatch && current) {
    const sec = secMatch[1].trim();
    if (sec === "用户摘要") {
      // 用户摘要仅用于更新弹窗（updater.json notes），应用内更新历史跳过
      mode = "skip";
      currentCategory = null;
      currentItem = null;
      currentHighlight = null;
    } else if (sec === "亮点" || sec === "Highlights") {
      // C：头条亮点 → 单独收集，UI 顶部渐变条突出
      mode = "highlights";
      currentItem = null;
      currentHighlight = null;
    } else {
      mode = "items";
      currentCategory = SECTION_MAP[sec] || "improve";
      currentItem = null;
      currentHighlight = null;
    }
    continue;
  }

  // 条目：以 - 或 * 开头
  if (mode === "skip") continue;
  const itemMatch = line.match(/^\s*[-*]\s+(.*)$/);
  if (itemMatch && current) {
    if (mode === "highlights") {
      if (currentHighlight !== null) current.highlights.push(currentHighlight);
      currentHighlight = cleanText(itemMatch[1]);
    } else {
      if (currentItem) current.items.push(currentItem);
      currentItem = {
        category: currentCategory || "improve",
        text: cleanText(itemMatch[1]),
      };
    }
    continue;
  }

  // 续行（非标题、且存在当前条目/亮点）→ 追加
  if (
    line.trim() &&
    !line.startsWith("###") &&
    !line.startsWith("##")
  ) {
    if (mode === "highlights") {
      if (currentHighlight !== null) currentHighlight += " " + cleanText(line);
    } else if (currentItem) {
      currentItem.text += " " + cleanText(line);
    }
  }
}

// 收尾最后一个版本
if (current) {
  if (currentItem) current.items.push(currentItem);
  if (currentHighlight !== null) current.highlights.push(currentHighlight);
  entries.push(current);
}

if (entries.length === 0) {
  fail("CHANGELOG.md 未解析出任何版本条目");
}

// 按语义版本号降序排序（CHANGELOG.md 物理顺序未必严格倒序，如 2.2.16/2.2.17 错位、2.2.18–2.2.21 缺失）
entries.sort((a, b) => compareVersion(a.version, b.version));

// 截断到最近 N 个
const limited = entries.slice(0, MAX_ENTRIES);
info(`解析到 ${entries.length} 个版本，生成最近 ${limited.length} 个`);

// 生成 TS
function toLiteral(str) {
  return JSON.stringify(str);
}

let out = "";
out += `// AUTO-GENERATED by scripts/gen-changelog.mjs — DO NOT EDIT.\n`;
out += `// 数据源：根目录 CHANGELOG.md（Keep a Changelog），唯一手写源；predev/prebuild 自动重新生成。\n`;
out += `import type { ChangelogEntry } from "./about";\n\n`;
out += `export const CHANGELOG: ChangelogEntry[] = [\n`;
for (const entry of limited) {
  out += `  {\n`;
  out += `    version: ${toLiteral(entry.version)},\n`;
  out += `    date: ${toLiteral(entry.date)},\n`;
  if (entry.highlights && entry.highlights.length) {
    out += `    highlights: [\n`;
    for (const h of entry.highlights) {
      out += `      ${toLiteral(h)},\n`;
    }
    out += `    ],\n`;
  }
  out += `    items: [\n`;
  for (const item of entry.items) {
    out += `      { category: ${toLiteral(item.category)}, text: ${toLiteral(item.text)} },\n`;
  }
  out += `    ],\n`;
  out += `  },\n`;
}
out += `];\n`;

fs.writeFileSync(OUT_PATH, out, "utf-8");
success(`已生成 ${OUT_PATH}（${limited.length} 个版本，${limited[0]?.version} 为最新）`);
