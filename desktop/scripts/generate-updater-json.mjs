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
// 二进制下载基线 URL：默认 GitHub；CI/生产可经 UPDATER_DOWNLOAD_BASE 指向镜像（如 ghproxy.net），
// 解决国内用户直连 GitHub 下载慢的问题。镜像需能代理 GitHub Release 资产（updater.json 与 .exe 同源）。
const GITHUB_RELEASE_BASE =
  process.env.UPDATER_DOWNLOAD_BASE ||
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download`;
// 镜像跨平台结构差异支持（Gitee 场景）：Gitee 的 raw 文件直链不是 "base/tag/filename" 这种
// GitHub Release 风格拼法（而是 "owner/repo/raw/ref/path"），无法用 UPDATER_DOWNLOAD_BASE 表达。
// 设置 UPDATER_URL_TEMPLATE 时完全接管 URL 拼接，支持 {tag}/{filename} 占位符，优先级高于
// UPDATER_DOWNLOAD_BASE（两者互斥，不同时使用后者）。
const URL_TEMPLATE = process.env.UPDATER_URL_TEMPLATE || null;
// 输出文件名可配：Gitee 变体与 GitHub 变体需输出为不同文件（updater.json vs updater-gitee.json），
// 同一份脚本跑两次即可，无需复制一份。
const OUTPUT_FILENAME = process.env.UPDATER_OUTPUT_FILENAME || "updater.json";

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
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
    // 签名缺失直接 fail：写出空签名的 updater.json 会在运行时校验失败、自动更新整条断掉，
    // 且毫无报错。宁可在构建期就红，也不发带病版本。
    fail(
      `找到 ${pkgFile} 但没有 .sig 签名文件。\n` +
        "原因：tauri.conf.json 的 bundle.createUpdaterArtifacts 未开启，或构建时未设置 TAURI_SIGNING_PRIVATE_KEY。\n" +
        "修复：确认 tauri.conf.json 中 bundle.createUpdaterArtifacts = true，且 CI/本地已配置签名私钥。"
    );
  }
  const signature = fs.readFileSync(path.join(dirPath, sigFile), "utf-8").trim();
  if (!signature) {
    fail(`${sigFile} 内容为空 → 无法为 updater 生成有效签名，终止发布（避免自动更新校验失败）。`);
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

  // URL_TEMPLATE 优先：支持 Gitee 这种与 GitHub Release 拼法形状不同的镜像（见上方注释）。
  // 注意用 replaceAll 而非 replace：模板里 {tag} 可能出现不止一次（如 Gitee 模板
  // ".../raw/{tag}/releases/{tag}/{filename}"），单次 replace 只换第一处会留下未替换的 {tag}。
  const downloadUrl = URL_TEMPLATE
    ? URL_TEMPLATE.replaceAll("{tag}", tag).replaceAll("{filename}", artifact.fileName)
    : `${GITHUB_RELEASE_BASE}/${tag}/${artifact.fileName}`;
  success(`windows-x86_64: ${artifact.fileName}`);
  info(`下载 URL: ${downloadUrl}`);

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
  const outputPath = path.join(distDir, OUTPUT_FILENAME);
  fs.writeFileSync(outputPath, JSON.stringify(updaterJson, null, 2), "utf-8");

  success(`已生成: ${outputPath}`);
  console.log(JSON.stringify(updaterJson, null, 2));
}

main();
