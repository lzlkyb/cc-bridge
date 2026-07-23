#!/usr/bin/env node
/**
 * release.mjs — 一键发版脚本
 *
 * 用法：
 *   npm run release -- --patch            # 2.3.12 → 2.3.13
 *   npm run release -- --minor            # 2.3.12 → 2.4.0
 *   npm run release -- --major            # 2.3.12 → 3.0.0
 *   npm run release -- --version 2.3.99   # 显式指定
 *   npm run release -- --patch --dry-run  # 只打印将要做什么，不改任何文件
 *   npm run release -- --patch --yes      # 非交互：用默认摘要，自动确认 push/tag
 *   npm run release -- --patch --skip-tests  # 跳过 cargo test + clippy 门禁（不推荐）
 *
 * 流程（自动）：
 *   1. 计算新版本号 → 只改 Cargo.toml（唯一真源）
 *   2. 调 sync-version：同步 tauri.conf.json + package.json（Cargo.lock 由 cargo 更新）
 *   3. 在 CHANGELOG.md 顶部插新版本段（更新摘要交互填写；变更列表由 git log 自动分类生成草稿）
 *   4. 在 README 版本历史表插行
 *   5. 重新生成 changelog.generated.ts
 *   6. cargo test + cargo clippy --no-default-features 门禁（不过不提交）
 *   7. git add 相关文件 → commit → push origin main → tag vX.Y.Z → push tag
 *
 * 设计要点：
 *   - 版本号只动 Cargo.toml 一处，其余全自动同步（治愈"漏改版本号"）。
 *   - 非 TTY 环境（无 --yes）只准备到 commit，不 push/tag，避免误发。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, "..");
const ROOT = path.resolve(DESKTOP, "..");

const CARGO_PATH = path.join(DESKTOP, "src-tauri", "Cargo.toml");
const CONF_PATH = path.join(DESKTOP, "src-tauri", "tauri.conf.json");
const PKG_PATH = path.join(DESKTOP, "package.json");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const README_PATH = path.join(ROOT, "README.md");
const GEN_TS_PATH = path.join(DESKTOP, "src", "lib", "changelog.generated.ts");

// ── 参数解析 ──
const argv = process.argv.slice(2);
const getOpt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(name);

const DRY_RUN = hasFlag("--dry-run");
const YES = hasFlag("--yes");
const SKIP_TESTS = hasFlag("--skip-tests");
let bumpType = null;
let explicitVersion = getOpt("--version");
if (hasFlag("--patch")) bumpType = "patch";
else if (hasFlag("--minor")) bumpType = "minor";
else if (hasFlag("--major")) bumpType = "major";
if (!bumpType && !explicitVersion) bumpType = "patch"; // 默认 patch

// ── 工具函数 ──
function run(cmd, cwd = ROOT, inherit = true) {
  console.log(`\x1b[35m$ ${cmd}\x1b[0m  (cwd: ${path.relative(ROOT, cwd) || "."})`);
  return execSync(cmd, { cwd, stdio: inherit ? "inherit" : "pipe" });
}
function readCargoVersion() {
  const txt = fs.readFileSync(CARGO_PATH, "utf-8");
  const m = txt.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("Cargo.toml 未找到 version 字段");
  return m[1];
}
function bumpSemver(cur, type, next) {
  if (next) return next;
  const [a, b, c] = cur.split(".").map(Number);
  if (type === "major") return `${a + 1}.0.0`;
  if (type === "minor") return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`; // patch
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
async function ask(question, defaultValue) {
  if (YES) return defaultValue ?? "";
  // 非 TTY（如 CI / 自动化环境）不交互，直接返回默认，避免 readline 在空 stdin 上抛错导致整段 CHANGELOG 没写
  if (!process.stdin.isTTY) return defaultValue ?? "";
  const rl = readline.createInterface({ input, output });
  try {
    const ans = (await rl.question(`\x1b[36m${question}\x1b[0m `)).trim();
    return ans || defaultValue || "";
  } finally {
    rl.close();
  }
}

// ── 主流程 ──
async function main() {
  const current = readCargoVersion();
  const next = bumpSemver(current, bumpType, explicitVersion);
  console.log(`\x1b[32m发版计划：\x1b[0m ${current} → ${next}`);

  if (DRY_RUN) {
    console.log("[dry-run] 以下为将执行步骤，不改动任何文件：");
    console.log(`  1. Cargo.toml version: ${current} → ${next}`);
    console.log("  2. node scripts/sync-version.mjs（同步 tauri.conf.json + package.json）");
    console.log(`  3. CHANGELOG.md 顶部插入 ## [${next}] - ${todayISO()} 段`);
    console.log("  4. README.md 版本历史表插入行");
    console.log("  5. node scripts/gen-changelog.mjs（重新生成 changelog.generated.ts）");
    if (!SKIP_TESTS) console.log("  6. cargo test + cargo clippy --no-default-features 门禁");
    console.log(`  7. git add 版本文件+CHANGELOG+README+generated.ts → commit → push → tag v${next} → push tag`);
    return;
  }

  // 1. bump Cargo.toml（唯一真源）
  let cargoTxt = fs.readFileSync(CARGO_PATH, "utf-8");
  cargoTxt = cargoTxt.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`);
  fs.writeFileSync(CARGO_PATH, cargoTxt, "utf-8");
  console.log(`\x1b[32m[1/7]\x1b[0m Cargo.toml → ${next}`);

  // 2. 同步其余文件
  run(`node ${path.join(__dirname, "sync-version.mjs")}`, DESKTOP);
  console.log(`\x1b[32m[2/7]\x1b[0m 已同步 tauri.conf.json + package.json`);

  // 3. 收集 git log 生成变更草稿
  let logEntries = [];
  try {
    const lastTag = execSync("git describe --tags --abbrev=0", { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    const log = execSync(`git log --oneline ${lastTag}..HEAD`, { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    logEntries = log ? log.split("\n").map((l) => l.replace(/^[0-9a-f]+\s+/, "")) : [];
    console.log(`\x1b[32m[3/7]\x1b[0m 自 ${lastTag} 起 ${logEntries.length} 条 commit 纳入草稿`);
  } catch {
    console.log("\x1b[33m[3/7]\x1b[0m 未找到上一 tag，跳过 git log 草稿");
  }

  // 交互：更新摘要（用户向，显示在更新弹框）
  const summary =
    (await ask(`填写「更新摘要」（用户向，回车用默认）:`, `v${next} 版本更新`)) ||
    `v${next} 版本更新`;

  // 把 git log 按前缀分类成 CHANGELOG 小节草稿
  const sections = { 新增: [], 变更: [], 修复: [], 优化: [], 安全: [] };
  const mapPrefix = (line) => {
    if (/^feat/i.test(line)) return "新增";
    if (/^fix/i.test(line)) return "修复";
    if (/^(chg|change|refactor)/i.test(line)) return "变更";
    if (/^perf/i.test(line)) return "优化";
    if (/^sec/i.test(line)) return "安全";
    return "变更";
  };
  for (const line of logEntries) {
    const sec = mapPrefix(line);
    const msg = line.replace(/^(feat|fix|chg|change|refactor|perf|sec)(\(.*?\))?:\s*/i, "");
    sections[sec].push(`- ${msg}`);
  }
  const fallbackSections = `### 变更\n- 见 git 提交历史`;

  // 4. 插入 CHANGELOG.md
  let changelog = fs.readFileSync(CHANGELOG_PATH, "utf-8");

  // 消费 ## [Unreleased]：把其用户向小节并入本次发布，并从 CHANGELOG 删除该段，
  // 避免「Unreleased 永远留着 / 下次又踩」以及本次发布漏写已积累条目。
  const unrelMatch = changelog.match(/^##\s+\[Unreleased\][\s\S]*?(?=\n##\s+\[|$)/m);
  if (unrelMatch) {
    const body = unrelMatch[0];
    const skipSec = new Set([
      "用户摘要", "技术", "技术细节", "说明", "实现说明", "开发者", "亮点", "Highlights",
    ]);
    const secRe = /###\s+([^\n]+)\n([\s\S]*?)(?=\n###\s+|\n##\s+|$)/g;
    let m;
    while ((m = secRe.exec(body))) {
      const name = m[1].trim();
      if (skipSec.has(name)) continue;
      const items = m[2]
        .split("\n")
        .map((l) => l.match(/^\s*[-*]\s+(.*)$/))
        .filter(Boolean)
        .map((x) => `- ${x[1].trim()}`);
      if (items.length) {
        if (!sections[name]) sections[name] = [];
        sections[name].push(...items);
      }
    }
    changelog = changelog.replace(unrelMatch[0] + "\n", "");
    console.log(`\x1b[32m[4/7]\x1b[0m 已消费并归档 ## [Unreleased]`);
  }

  const sectionLines = Object.entries(sections)
    .filter(([, items]) => items.length)
    .map(([name, items]) => `### ${name}\n${items.join("\n")}`)
    .join("\n");
  const newBlock = `## [${next}] - ${todayISO()}\n\n### 更新摘要\n${summary}\n\n${
    sectionLines || fallbackSections
  }\n\n`;
  // 必须插到第一个「版本段标题」（## [x.y.z]）之前，而非第一个 # 行（# Changelog 大标题）之后——
  // 否则新段会被排在文件头描述与首个版本段之间，解析器按 ## [x.y.z] 分段时它既不属于任何版本、也不被 git 正确纳入。
  const firstVer = changelog.match(/^##\s+\[/m);
  if (firstVer && firstVer.index !== undefined) {
    changelog = changelog.slice(0, firstVer.index) + newBlock + changelog.slice(firstVer.index);
  } else {
    changelog = changelog.replace(/(^#.*\n)/, `$1\n${newBlock}`);
  }
  fs.writeFileSync(CHANGELOG_PATH, changelog, "utf-8");
  console.log(`\x1b[32m[4/7]\x1b[0m CHANGELOG.md 插入 [${next}] 段`);

  // 5. 插入 README 版本历史行
  let readme = fs.readFileSync(README_PATH, "utf-8");
  const readmeRow = `| v${next} | ${summary} |`;
  readme = readme.replace(/(\n\| v[\d.]+\s*\|)/, `\n${readmeRow}$1`);
  fs.writeFileSync(README_PATH, readme, "utf-8");
  console.log(`\x1b[32m[5/7]\x1b[0m README.md 插入版本行`);

  // 6. 重新生成 changelog.generated.ts
  run(`node ${path.join(__dirname, "gen-changelog.mjs")}`, DESKTOP);
  console.log(`\x1b[32m[6/7]\x1b[0m 已重新生成 changelog.generated.ts`);

  // 7. 门禁：cargo test + clippy
  if (!SKIP_TESTS) {
    console.log("\x1b[35m[门禁] cargo test\x1b[0m");
    run("cargo test", path.join(DESKTOP, "src-tauri"));
    console.log("\x1b[35m[门禁] cargo clippy --no-default-features\x1b[0m");
    run("cargo clippy --no-default-features", path.join(DESKTOP, "src-tauri"));
  }

  // 8. git add + commit + push + tag
  const files = [
    "desktop/src-tauri/Cargo.toml",
    "desktop/src-tauri/Cargo.lock",
    "desktop/src-tauri/tauri.conf.json",
    "desktop/package.json",
    "CHANGELOG.md",
    "README.md",
    "desktop/src/lib/changelog.generated.ts",
  ];
  run(`git add ${files.map((f) => `"${f}"`).join(" ")}`);
  // 防漏纳：确认关键文件确实被 git 纳入（CHANGELOG 写入异常时 git add 会静默跳过）
  const unstaged = execSync("git status --porcelain", { cwd: ROOT, stdio: "pipe" })
    .toString()
    .trim();
  if (unstaged) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 发版文件未全部纳入暂存区，已中止以免漏发：\n${unstaged}`,
    );
    process.exit(1);
  }
  run(`git commit -m "chg: 发版 v${next}"`);
  console.log(`\x1b[32m[7/7]\x1b[0m 已 commit 发版 v${next}`);

  const wantPush = YES || (await ask("确认 push main 并打 tag v" + next + " ? (y/N)", "")) === "y";
  if (!wantPush) {
    console.log("\x1b[33m已 commit，未 push/tag。\x1b[0m 手动执行：");
    console.log(`  git push origin main && git tag v${next} && git push origin v${next}`);
    return;
  }
  run(`git push origin main`);
  run(`git tag v${next}`);
  run(`git push origin v${next}`);
  console.log(`\x1b[32m✅ 发版 v${next} 完成，CI 正在构建。\x1b[0m`);
}

main().catch((e) => {
  console.error(`\x1b[31m[RELEASE ERROR]\x1b[0m ${e.message || e}`);
  process.exit(1);
});
