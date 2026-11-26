#!/usr/bin/env node
/**
 * generate-update-policy.mjs
 *
 * 把「本次发版是否强制更新」编译成客户端读取的 `update-policy.json`。
 *
 * 输入：
 *   - 版本真源：src-tauri/tauri.conf.json 的 `version`（与 Cargo.toml 由 sync-version 同步）
 *   - 发版策略：desktop/release-policy.json（由 `npm run release` 写入并提交，见 release.mjs）
 *   - 可选 POLICY_OUTPUT 指定输出路径，默认 desktop/dist/update-policy.json
 *
 * 为什么不把字段塞进 updater.json：那份文件由 tauri-plugin-updater 解析，
 * 自定义字段是拿别人的 schema 赌未来；而且策略要能独立热更（改强制范围不必重发安装包）。
 *
 * 🔴 默认不强制：release-policy.json 缺失或没有 `enforced: true` 时一律输出
 * `enforced: false`。发版脚本每次都会重写这个文件，所以「上次发过强制、这次忘了关」
 * 不可能发生 —— 默认值由脚本保证，不靠人记。
 *
 * 🔴 min > latest 直接构建期失败：策略要求升到一个还不存在的版本，会把用户锁死
 * 且「更新到最新」也解除不了。客户端也有同样的 fail-open 校验，这里是第二道。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONF_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");
const POLICY_SRC = path.join(ROOT, "release-policy.json");
const OUTPUT = process.env.POLICY_OUTPUT || path.join(ROOT, "dist", "update-policy.json");

export const SCHEMA = 1;
/** 强制生效前的缓冲天数。1 天是产品决定：给用户一个「今天先干活、明天必须升」的窗口。 */
export const DEFAULT_GRACE_DAYS = 1;

/** `x.y.z` / `vX.Y.Z` → [major, minor, patch]；其余返回 null。 */
export function parseVersion(raw) {
  if (typeof raw !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 三段的字典序比较；任一非法返回 null（调用方按「配置错误」处理）。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * 纯函数：生成策略对象。所有校验都在这里，方便单测直接钉边界。
 *
 * @param {object} args
 * @param {string} args.version 本次发布版本（真源）
 * @param {object} [args.policy] release-policy.json 的内容
 * @param {Date}   [args.now]    注入时间，测试用
 */
export function buildPolicy({ version, policy = {}, now = new Date() }) {
  const latestVersion = version;
  // 不强制时 min 仍写 latest，保证 `min <= latest` 恒成立、策略文件语义自洽。
  const minSupportedVersion = policy.minSupportedVersion || latestVersion;
  const enforced = policy.enforced === true;

  if (!parseVersion(latestVersion)) {
    throw new Error(`版本号不合法: ${latestVersion}`);
  }
  if (!parseVersion(minSupportedVersion)) {
    throw new Error(`minSupportedVersion 不合法: ${minSupportedVersion}（只接受 x.y.z）`);
  }
  const cmp = compareVersions(minSupportedVersion, latestVersion);
  if (cmp > 0) {
    throw new Error(
      `minSupportedVersion (${minSupportedVersion}) 高于本次版本 (${latestVersion})：` +
        "这会把所有用户锁死且「更新到最新」也解除不了，拒绝生成策略。",
    );
  }

  const graceDays = Number.isFinite(policy.graceDays) ? policy.graceDays : DEFAULT_GRACE_DAYS;
  if (graceDays < 0) {
    throw new Error(`graceDays 不能为负: ${graceDays}`);
  }
  if (enforced && !policy.message) {
    // 遮罩上必须有一句人话，否则用户只看到「必须更新」却不知道为什么。
    console.warn("[WARN] 强制更新未提供 message，将使用默认说明");
  }

  return {
    schema: SCHEMA,
    latestVersion,
    minSupportedVersion,
    enforced,
    graceUntil: new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString(),
    message:
      (policy.message || "").trim() || `请升级到 v${minSupportedVersion} 后继续使用。`,
    updatedAt: now.toISOString(),
  };
}

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
}

function main() {
  if (!fs.existsSync(CONF_PATH)) fail(`找不到 tauri.conf.json: ${CONF_PATH}`);
  const conf = JSON.parse(fs.readFileSync(CONF_PATH, "utf-8"));
  if (!conf.version) fail("tauri.conf.json 缺少 version 字段");

  let policy = {};
  if (fs.existsSync(POLICY_SRC)) {
    try {
      policy = JSON.parse(fs.readFileSync(POLICY_SRC, "utf-8"));
    } catch (e) {
      fail(`release-policy.json 解析失败: ${e.message}`);
    }
  } else {
    info("未找到 release-policy.json，按「不强制更新」生成");
  }

  let result;
  try {
    result = buildPolicy({ version: conf.version, policy });
  } catch (e) {
    fail(e.message);
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2), "utf-8");
  info(
    `已生成 ${path.relative(ROOT, OUTPUT)}：enforced=${result.enforced} ` +
      `min=${result.minSupportedVersion} latest=${result.latestVersion} graceUntil=${result.graceUntil}`,
  );
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
