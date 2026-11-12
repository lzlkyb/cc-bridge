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
 *   0. 校验 CHANGELOG.md 的 ## [Unreleased]：必须是用户向文案，不合规直接中止（改任何文件之前）
 *   1. 计算新版本号 → 只改 Cargo.toml（唯一真源）
 *   2. 调 sync-version：同步 tauri.conf.json + package.json（Cargo.lock 由 cargo 更新）
 *   3. 把 [Unreleased] 的亮点 / 更新摘要 / 条目原样搬成新版本段，README 复用同一句摘要
 *   4. 在 README 版本历史表插行
 *   5. 重新生成 changelog.generated.ts
 *   6. cargo test + cargo clippy --no-default-features 门禁（不过不提交）
 *   7. git add 相关文件 → commit → push origin main → tag vX.Y.Z → push tag
 *
 * 设计要点：
 *   - 版本号只动 Cargo.toml 一处，其余全自动同步（治愈"漏改版本号"）。
 *   - 🔴 发布说明的唯一来源是手写的 ## [Unreleased]。**git 提交标题永不进入 CHANGELOG**：
 *     2026-11-10 前的做法是拿 git log 按前缀分类当条目，v3.1.2 / v3.1.5 两次产出
 *     「docs: 补充变更」这类开发者干条目并与手写内容重复，每次还得发版后手工 amend 重写。
 *     现在由 scripts/check-release-notes.mjs 把「小白能看懂」变成硬闸。
 *   - 非 TTY 环境（无 --yes）只准备到 commit，不 push/tag，避免误发。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  parseNotes,
  validate,
  formatReport,
  removeUnreleased,
  collectItemSections,
} from "./check-release-notes.mjs";

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
/**
 * 读文本并统一成 LF。
 *
 * 🔴 必须做这一步：CHANGELOG.md 在工作区是 CRLF（core.autocrlf），而下面解析
 * `[Unreleased]` 用的 `/^\s*[-*]\s+(.*)$/` 里，JS 的 `.` **不匹配 `\r`**、`$` 又只认
 * 字符串真正的结尾 —— 于是 "‑ 某条改动\r" 这种行一条都匹配不上，`items` 恒为空。
 * 后果不是报错而是**静默丢数据**：整段 [Unreleased] 被删掉、条目一条没并进新版本段
 * （2026-10-22 v3.0.0 发版实测，43 条手写条目全丢，靠 git 历史才捞回来）。
 */
function readTextNormalized(p) {
  return fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
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

  // 0. 更新日志硬闸。必须在改 Cargo.toml 之前：不合格就一个字节都不动，
  //    避免留下「版本号已 bump、发布说明却没写」的半成品。
  const sourceMd = readTextNormalized(CHANGELOG_PATH);
  const parsed = parseNotes(sourceMd, { stage: "unreleased" });
  const report = validate(parsed);
  console.log(formatReport(report, CHANGELOG_PATH));
  if (report.errors.length) {
    if (DRY_RUN) {
      console.log("[dry-run] 上面的问题会让实际发版被拦下（dry-run 继续，不改文件）。");
    } else {
      console.error("\x1b[31m[RELEASE ERROR]\x1b[0m 更新日志不合规，已中止。");
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log("[dry-run] 以下为将执行步骤，不改动任何文件：");
    console.log(`  1. Cargo.toml version: ${current} → ${next}`);
    console.log("  2. node scripts/sync-version.mjs（同步 tauri.conf.json + package.json）");
    console.log(`  3. 把 ## [Unreleased] 原样搬成 ## [${next}] - ${todayISO()} 段（含亮点 / 更新摘要）`);
    console.log("  4. README.md 版本历史表插入行（复用更新摘要）");
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

  // 3. git log 只用来提醒「这一版攒了多少提交」，绝不当发布说明。
  //    发布说明全部来自第 0 步校验过的 [Unreleased] 手写内容。
  try {
    const lastTag = execSync("git describe --tags --abbrev=0", { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    const count = execSync(`git rev-list --count ${lastTag}..HEAD`, { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    console.log(
      `\x1b[32m[3/7]\x1b[0m 自 ${lastTag} 起 ${count} 条 commit；发布说明只取 [Unreleased] 手写内容`,
    );
  } catch {
    console.log("\x1b[33m[3/7]\x1b[0m 未找到上一 tag，不影响发布说明生成");
  }

  const summary = parsed.summary;
  const highlights = parsed.highlights.map((h) => `- ${h.text}`);
  const sections = collectItemSections(parsed);
  if (!Object.keys(sections).length) {
    console.error("\x1b[31m[RELEASE ERROR]\x1b[0m [Unreleased] 里没有任何可发布的条目，已中止。");
    process.exit(1);
  }

  // 4. 插入 CHANGELOG.md：把第 0 步校验过的 [Unreleased] 原样搬成新版本段。
  //    🔴 不再用 git log 生成条目，也不再靠交互问摘要——亮点与更新摘要都已从
  //    [Unreleased] 读出，所以发版后不需要 amend 重写（v3.1.2 / v3.1.5 都栽在这）。
  //    removeUnreleased 的正则沿用旧版：结尾用 `$(?![\s\S])` 才是整串结尾，
  //    带 m 标记时裸 `$` 只匹配行尾，会把整段 Unreleased 留在文件抬头。
  const highlightBlock = highlights.length
    ? `### 亮点\n${highlights.join("\n")}\n\n`
    : "";
  const sectionLines = Object.entries(sections)
    .map(([name, items]) => `### ${name}\n${items.join("\n")}`)
    // 两个 \n：单个 \n 会让下一个 "###" 紧贴列表项，Markdown 渲染成一整段。
    .join("\n\n");
  const newBlock = `## [${next}] - ${todayISO()}\n\n${highlightBlock}### 更新摘要\n${summary}\n\n${sectionLines}\n\n`;
  const changelog = removeUnreleased(sourceMd);
  // 必须插到第一个「版本段标题」之前，而非 # Changelog 大标题之后——否则新段
  // 会排在文件头描述与首个版本段之间，解析器按 ## [x.y.z] 分段时它不属于任何版本。
  const firstVer = changelog.match(/^##\s+\[/m);
  const finalChangelog = firstVer && firstVer.index !== undefined
    ? changelog.slice(0, firstVer.index) + newBlock + changelog.slice(firstVer.index)
    : changelog.replace(/(^#.*\n)/, `$1\n${newBlock}`);
  fs.writeFileSync(CHANGELOG_PATH, finalChangelog, "utf-8");
  console.log(
    `\x1b[32m[4/7]\x1b[0m 已消费 ## [Unreleased]（${Object.values(sections).flat().length} 条），插入 [${next}] 段`,
  );

  // 5. 插入 README 版本历史行
  let readme = readTextNormalized(README_PATH);
  const readmeRow = `| v${next} | ${summary} |`;
  readme = readme.replace(/(\n\| v[\d.]+\s*\|)/, `\n${readmeRow}$1`);
  fs.writeFileSync(README_PATH, readme, "utf-8");
  console.log(`\x1b[32m[5/7]\x1b[0m README.md 插入版本行`);

  // 6. 重新生成 changelog.generated.ts
  run(`node ${path.join(__dirname, "gen-changelog.mjs")}`, DESKTOP);
  console.log(`\x1b[32m[6/7]\x1b[0m 已重新生成 changelog.generated.ts`);

  // 7. 门禁：cargo test + clippy
  // cargo test 必须 --no-default-features：notifications feature 会拉入 GUI DLL
  // 导致 test 二进制 0xc0000139（与 CI/pre-push 钩子保持一致）
  if (!SKIP_TESTS) {
    console.log("\x1b[35m[门禁] cargo test --no-default-features\x1b[0m");
    run("cargo test --no-default-features", path.join(DESKTOP, "src-tauri"));
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
  // 防漏纳：确认 7 个发版文件都已进入暂存区（CHANGELOG 写入异常时 git add 会静默跳过）。
  // 注意：不能用 `git status --porcelain` 判空——git add 之后这些文件在 porcelain 里
  // 显示为已暂存（首列 M），输出必然非空，会误判为漏纳而中止。改查暂存区文件清单。
  const staged = execSync("git diff --cached --name-only", { cwd: ROOT, stdio: "pipe" })
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = files.filter((f) => !staged.includes(f));
  if (missing.length) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 以下发版文件未被 git 纳入暂存区，已中止以免漏发：\n${missing.join("\n")}`,
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
