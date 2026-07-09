#!/usr/bin/env node
/**
 * generate-updater-json.mjs
 * 构建后自动生成 updater.json 用于 Tauri v2 自动更新（参考 PastePanda 同名脚本简化而来：
 * cc-bridge 只发 Windows NSIS 单平台，不需要多平台掃描）。
 *
 * 输入：src-tauri/target/release/bundle/nsis/ 下的 .exe + .exe.sig
 * 输出：dist/updater.json
 *
 * 仓库 owner/name 优先从 CI 自带的 GITHUB_REPOSITORY 环境变量读（格式 "owner/repo"），
 * 本地手动跑时回退到下面的常量。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUNDLE_DIR = path.join(ROOT, "src-tauri", "target", "release", "bundle");

const [FALLBACK_OWNER, FALLBACK_REPO] = ["lzlkyb", "cc-bridge"];
const [REPO_OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || `${FALLBACK_OWNER}/${FALLBACK_REPO}`).split("/");
const GITHUB_RELEASE_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download`;

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function warn(msg) {
  console.warn(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}
function info(msg) {
  console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}

function findNsisArtifact() {
  const dirPath = path.join(BUNDLE_DIR, "nsis");
  if (!fs.existsSync(dirPath)) return null;
  const files = fs.readdirSync(dirPath);
  const pkgFile = files.find((f) => f.endsWith(".exe") && !f.endsWith(".exe.sig"));
  if (!pkgFile) return null;

  const sigFile = files.find((f) => f === `${pkgFile}.sig`);
  if (!sigFile) {
    warn(`找到 ${pkgFile} 但没有 .sig 签名文件 → updater 将无法验证签名（确认 tauri.conf.json 的 bundle.createUpdaterArtifacts=true 且构建时已设置 TAURI_SIGNING_PRIVATE_KEY）`);
    return { fileName: pkgFile, signature: "" };
  }
  const signature = fs.readFileSync(path.join(dirPath, sigFile), "utf-8").trim();
  if (!signature) {
    warn(`${sigFile} 内容为空 → updater 将无法验证签名`);
    return { fileName: pkgFile, signature: "" };
  }
  return { fileName: pkgFile, signature };
}

function readVersionFromConf() {
  const confPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
  if (!fs.existsSync(confPath)) fail(`找不到 tauri.conf.json: ${confPath}`);
  const conf = JSON.parse(fs.readFileSync(confPath, "utf-8"));
  if (!conf.version) fail("tauri.conf.json 中未找到 version 字段");
  return conf.version;
}

function main() {
  const version = readVersionFromConf();
  const tag = process.env.GITHUB_RELEASE_TAG || `v${version}`;
  const notes = process.env.UPDATER_NOTES || `cc-bridge v${version}`;

  info(`仓库: ${REPO_OWNER}/${REPO_NAME}`);
  info(`版本: ${version}`);
  info(`Release Tag: ${tag}`);
  info(`扫描构建产物: ${BUNDLE_DIR}`);

  const artifact = findNsisArtifact();
  if (!artifact) {
    fail(
      "未找到 NSIS 构建产物。\n请先运行 npm run build 构建应用。\n确保 tauri.conf.json 中 bundle.createUpdaterArtifacts = true"
    );
  }

  const downloadUrl = `${GITHUB_RELEASE_BASE}/${tag}/${artifact.fileName}`;
  success(`windows-x86_64: ${artifact.fileName}`);

  const updaterJson = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: artifact.signature,
        url: downloadUrl,
      },
    },
  };

  const distDir = path.join(ROOT, "dist");
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  const outputPath = path.join(distDir, "updater.json");
  fs.writeFileSync(outputPath, JSON.stringify(updaterJson, null, 2), "utf-8");

  success(`已生成: ${outputPath}`);
  console.log(JSON.stringify(updaterJson, null, 2));
}

main();
