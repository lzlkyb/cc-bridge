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
 * 强制更新（默认关闭，见 desktop/release-policy.json）：
 *   npm run release -- --patch --force                 # 强制：min = 本次版本，缓冲 1 天
 *   npm run release -- --patch --force --min 3.4.2     # 强制：只锁 < 3.4.2
 *   npm run release -- --patch --force --grace 0       # 缓冲 0 天（发布即刻可锁）
 *   npm run release -- --patch --force --message "…"   # 强制遮罩上显示的原因
 *
 *   不带 --force 时，脚本**每次都会把** release-policy.json 重写为 { enforced: false }，
 *   所以上一次发过强制的策略不会残留到这一版 —— 「默认不强制」由脚本保证。
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
  applyRelease,
  checkReleaseShape,
  collectItemSections,
  renderVersionBlock,
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
  if (i < 0) return undefined;
  const value = argv[i + 1]?.trim();
  if (!value || value.startsWith("--")) {
    console.error(`\x1b[31m[RELEASE ERROR]\x1b[0m ${name} 缺少参数值。`);
    process.exit(1);
  }
  return value;
};
const hasFlag = (name) => argv.includes(name);

const DRY_RUN = hasFlag("--dry-run");
const YES = hasFlag("--yes");
const SKIP_TESTS = hasFlag("--skip-tests");
// ── 强制更新（默认关闭）──
// 不带 --force 时，每次发版都会把 release-policy.json 重写为 { enforced: false }，
// 所以「上一次发过强制、这一次忘了关」不可能发生——默认值由脚本保证，不靠人记。
const FORCE = hasFlag("--force");
const FORCE_MIN = getOpt("--min");
const FORCE_GRACE = getOpt("--grace");
const FORCE_MESSAGE = getOpt("--message");
// 这几个参数只在强制发版时有意义。静默忽略会让「我明明写了 --min」变成一次
// 不生效的强制发布，所以直接中止。
if (!FORCE && (FORCE_MIN || FORCE_GRACE !== undefined || FORCE_MESSAGE)) {
  console.error(
    "\x1b[31m[RELEASE ERROR]\x1b[0m --min / --grace / --message 只用于强制发版，请同时加 --force。",
  );
  process.exit(1);
}
const GRACE_DAYS = FORCE_GRACE === undefined ? 1 : Number(FORCE_GRACE);
if (!Number.isFinite(GRACE_DAYS) || GRACE_DAYS < 0) {
  console.error("\x1b[31m[RELEASE ERROR]\x1b[0m --grace 必须是不小于 0 的天数。");
  process.exit(1);
}
if (FORCE_MIN && !/^v?\d+\.\d+\.\d+$/.test(FORCE_MIN.trim())) {
  console.error("\x1b[31m[RELEASE ERROR]\x1b[0m --min 只接受 x.y.z。");
  process.exit(1);
}
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
  const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stableVersion.test(next)) throw new Error("发布版本必须是 X.Y.Z 格式");
  const previousParts = current.split(".").map(BigInt);
  const firstChange = next.split(".").map(BigInt).findIndex((part, index) => part !== previousParts[index]);
  if (firstChange < 0 || BigInt(next.split(".")[firstChange]) <= previousParts[firstChange]) {
    throw new Error("发布版本必须高于当前版本");
  }
  console.log(`\x1b[32m发版计划：\x1b[0m ${current} → ${next}`);

  // --min 高于本次版本 = 要求用户升到一个还没发布的版本：会把所有人锁死且
  // 「更新到最新」也解除不了。CI 侧还有一道同样的校验，这里提前拦是为了不等到
  // 构建阶段才红（dry-run 也能提前发现打错参数）。
  if (FORCE_MIN) {
    const cmp = (a, b) => {
      const pa = a.replace(/^v/, "").split(".").map(Number);
      const pb = b.replace(/^v/, "").split(".").map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    };
    if (cmp(FORCE_MIN, next) > 0) {
      console.error(
        `\x1b[31m[RELEASE ERROR]\x1b[0m --min (${FORCE_MIN}) 高于本次版本 (${next})：` +
          "这会要求用户升级到一个还不存在的版本，导致所有人被锁死且无法通过更新解除。",
      );
      process.exit(1);
    }
  }

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
    console.log(
      `  5b. 写入 release-policy.json：${
        FORCE
          ? `强制更新（min=${FORCE_MIN || next}，缓冲 ${GRACE_DAYS} 天）`
          : "不强制更新（默认）"
      }`,
    );
    if (!SKIP_TESTS) console.log("  6. cargo test + cargo clippy --no-default-features 门禁");
    console.log(`  7. git add 版本文件+CHANGELOG+README+generated.ts → commit → push → tag v${next} → push tag`);
    return;
  }

  const alreadyStaged = execSync("git diff --cached --name-only", { cwd: ROOT, encoding: "utf8" }).trim();
  if (alreadyStaged) {
    throw new Error(`暂存区已有改动。请先处理这些文件再发版：\n${alreadyStaged}`);
  }

  // 1. bump Cargo.toml（唯一真源）
  let cargoTxt = fs.readFileSync(CARGO_PATH, "utf-8");
  cargoTxt = cargoTxt.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`);
  fs.writeFileSync(CARGO_PATH, cargoTxt, "utf-8");
  console.log(`\x1b[32m[1/7]\x1b[0m Cargo.toml → ${next}`);

  // 2. 同步其余文件
  run("node scripts/sync-version.mjs", DESKTOP);
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
  const sections = collectItemSections(parsed);
  if (!Object.keys(sections).length) {
    console.error("\x1b[31m[RELEASE ERROR]\x1b[0m [Unreleased] 里没有任何可发布的条目，已中止。");
    process.exit(1);
  }

  // 4. 插入 CHANGELOG.md：把第 0 步校验过的 [Unreleased] 原样搬成新版本段。
  //    🔴 不再用 git log 生成条目，也不再靠交互问摘要——亮点与更新摘要都已从
  //    [Unreleased] 读出，所以发版后不需要 amend 重写（v3.1.2 / v3.1.5 都栽在这）。
  //    🔴 必须连骨架一起重建：applyRelease 会在消费旧段的同时补回空的
  //    ## [Unreleased]（含写法注释）。只删不建的话，下一轮就没地方写条目，而且
  //    pre-push 只看最新已发布段，不会报错——静默穿过去（v3.2.2 发版实测）。
  const newBlock = renderVersionBlock(parsed, next, todayISO());
  const finalChangelog = applyRelease(sourceMd, newBlock);
  const shapeError = checkReleaseShape(finalChangelog, next);
  if (shapeError) {
    console.error(`\x1b[31m[RELEASE ERROR]\x1b[0m ${shapeError}，已中止（未写盘）。`);
    process.exit(1);
  }
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

  // 5b. 强制更新策略：**每次发版都重写**，默认 { enforced: false }。
  // 🔴 这是「默认不强制」的唯一保证点：上一次选择过强制的文件不会遗留到这一版，
  //    也不依赖发版人记得手动改回来。
  const policyPath = path.join(DESKTOP, "release-policy.json");
  const releasePolicy = FORCE
    ? {
        enforced: true,
        minSupportedVersion: (FORCE_MIN || next).replace(/^v/, ""),
        graceDays: GRACE_DAYS,
        ...(FORCE_MESSAGE ? { message: FORCE_MESSAGE } : {}),
      }
    : { enforced: false };
  fs.writeFileSync(policyPath, `${JSON.stringify(releasePolicy, null, 2)}\n`, "utf-8");
  console.log(
    `\x1b[32m[5b/7]\x1b[0m release-policy.json：${
      FORCE
        ? `强制更新 min=${releasePolicy.minSupportedVersion}（缓冲 ${GRACE_DAYS} 天）`
        : "不强制更新（默认）"
    }`,
  );

  // 6. 重新生成 changelog.generated.ts
  run("node scripts/gen-changelog.mjs", DESKTOP);
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
    "desktop/release-policy.json",
    "CHANGELOG.md",
    "README.md",
    "desktop/src/lib/changelog.generated.ts",
  ];
  run(`git add ${files.map((f) => `"${f}"`).join(" ")}`);
  // 策略文件可能与上一版相同，git add 已确保文件存在，无须每次制造一处差异。
  // 其余文件都应随版本变化，仍检查暂存区，避免漏纳。
  // 注意：不能用 `git status --porcelain` 判空——git add 之后这些文件在 porcelain 里
  // 显示为已暂存（首列 M），输出必然非空，会误判为漏纳而中止。改查暂存区文件清单。
  const staged = execSync("git diff --cached --name-only", { cwd: ROOT, stdio: "pipe" })
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = files.filter((f) => f !== "desktop/release-policy.json" && !staged.includes(f));
  if (missing.length) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 以下发版文件未被 git 纳入暂存区，已中止以免漏发：\n${missing.join("\n")}`,
    );
    process.exit(1);
  }
  // A separate task may stage files while tests are running. Commit only the release paths.
  run(`git commit --only -m "chg: 发版 v${next}" -- ${files.map((f) => `"${f}"`).join(" ")}`);
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
