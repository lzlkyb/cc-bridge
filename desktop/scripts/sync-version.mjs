#!/usr/bin/env node
/**
 * sync-version.mjs
 * 开发/构建前自动将 Cargo.toml 的版本号同步到 tauri.conf.json + package.json。
 *
 * 设计原则：Cargo.toml 是版本号唯一来源（/health 返回 CARGO_PKG_VERSION、CI build.yml 也读它、
 * Rust 生态惯例）。每次 `npm run build` / `npm run dev` 前自动执行（package.json 的 prebuild/predev 钩子），
 * 确保编译进二进制 / get_status 返回的版本与 Cargo.toml 一致，治愈 CLAUDE.md 规则 2 靠人肉同步的问题。
 *
 * 发版只需改 Cargo.toml 一处：`npm run release` 会自动 bump 它并触发本脚本同步其余文件
 * （Cargo.lock 由 cargo 在后续 test/build 时自动更新）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CARGO_PATH = path.join(ROOT, "src-tauri", "Cargo.toml");
const CONF_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");
const PKG_PATH = path.join(ROOT, "package.json");

function fail(msg) {
  console.error(`\x1b[31m[SYNC-VERSION ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[SYNC-VERSION]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[SYNC-VERSION OK]\x1b[0m ${msg}`);
}

// ── 读 Cargo.toml 真源 ──
if (!fs.existsSync(CARGO_PATH)) fail(`找不到 Cargo.toml: ${CARGO_PATH}`);
const cargoContent = fs.readFileSync(CARGO_PATH, "utf-8");
const versionRegex = /^version\s*=\s*"([^"]+)"/m;
const cargoMatch = cargoContent.match(versionRegex);
if (!cargoMatch) fail("Cargo.toml 中未找到 [package] version 字段");
const cargoVersion = cargoMatch[1];
info(`Cargo.toml 版本（真源）: ${cargoVersion}`);

// ── 同步 tauri.conf.json ──
if (!fs.existsSync(CONF_PATH)) fail(`找不到 tauri.conf.json: ${CONF_PATH}`);
const conf = JSON.parse(fs.readFileSync(CONF_PATH, "utf-8"));
if (conf.version === cargoVersion) {
  success(`tauri.conf.json 版本一致: ${cargoVersion}`);
} else {
  info(`tauri.conf.json 版本不同步: ${conf.version} → ${cargoVersion}`);
  conf.version = cargoVersion;
  fs.writeFileSync(CONF_PATH, JSON.stringify(conf, null, 2) + "\n", "utf-8");
  success(`已同步 tauri.conf.json: ${conf.version} → ${cargoVersion}`);
}

// ── 同步 package.json ──
if (!fs.existsSync(PKG_PATH)) fail(`找不到 package.json: ${PKG_PATH}`);
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
if (pkg.version === cargoVersion) {
  success(`package.json 版本一致: ${cargoVersion}`);
} else {
  info(`package.json 版本不同步: ${pkg.version} → ${cargoVersion}`);
  pkg.version = cargoVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  success(`已同步 package.json: ${pkg.version} → ${cargoVersion}`);
}
