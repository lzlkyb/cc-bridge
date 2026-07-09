#!/usr/bin/env node
/**
 * sync-version.mjs
 * 构建/开发前自动将 tauri.conf.json 的版本号同步到 Cargo.toml + package.json。
 *
 * 设计原则：tauri.conf.json 是版本号唯一来源。
 * 每次 `npm run build` / `npm run dev` 前自动执行（package.json 的 prebuild/predev钩子），
 * 确保编译进二进制/get_status 返回的版本与 conf 一致，治愈 CLAUDE.md 规则 2 靠人肉同步的问题。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONF_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");
const CARGO_PATH = path.join(ROOT, "src-tauri", "Cargo.toml");
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

if (!fs.existsSync(CONF_PATH)) {
  fail(`找不到 tauri.conf.json: ${CONF_PATH}`);
}
const conf = JSON.parse(fs.readFileSync(CONF_PATH, "utf-8"));
const confVersion = conf.version;
if (!confVersion) {
  fail("tauri.conf.json 中未找到 version 字段");
}

// ── 同步 Cargo.toml ──
if (!fs.existsSync(CARGO_PATH)) {
  fail(`找不到 Cargo.toml: ${CARGO_PATH}`);
}
let cargoContent = fs.readFileSync(CARGO_PATH, "utf-8");
const versionRegex = /^version\s*=\s*"([^"]+)"/m;
const cargoMatch = cargoContent.match(versionRegex);
if (!cargoMatch) {
  fail("Cargo.toml 中未找到 [package] version 字段");
}
const cargoVersion = cargoMatch[1];
if (cargoVersion === confVersion) {
  success(`Cargo.toml 版本一致: ${confVersion}`);
} else {
  info(`Cargo.toml 版本不同步: ${cargoVersion} → ${confVersion}`);
  cargoContent = cargoContent.replace(versionRegex, `version = "${confVersion}"`);
  fs.writeFileSync(CARGO_PATH, cargoContent, "utf-8");
  success(`已同步 Cargo.toml: ${cargoVersion} → ${confVersion}`);
}

// ── 同步 package.json ──
if (!fs.existsSync(PKG_PATH)) {
  fail(`找不到 package.json: ${PKG_PATH}`);
}
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
if (pkg.version === confVersion) {
  success(`package.json 版本一致: ${confVersion}`);
} else {
  info(`package.json 版本不同步: ${pkg.version} → ${confVersion}`);
  pkg.version = confVersion;
  // 保留原有缩进风格（2 空格），末尾换行与现有文件保持一致。
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  success(`已同步 package.json: ${pkg.version} → ${confVersion}`);
}
