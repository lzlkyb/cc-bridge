#!/usr/bin/env node
/**
 * generate-updater-json.mjs
 * 构建后自动生成 updater.json 用于 Tauri v2 自动更新。
 *
 * 输入（按当前平台自动探测，扫到就收）：
 *   - src-tauri/target/release/bundle/nsis/  下的 .exe + .exe.sig     → windows-x86_64
 *   - src-tauri/target/release/bundle/macos/ 下的 .app.tar.gz + .sig   → darwin-aarch64
 * 输出：dist/updater.json
 *
 * 平台 key 不能自己编：它由 tauri-plugin-updater 的 `updater_os()`-`updater_arch()`
 * 拼出来，macOS 返回的是 **`darwin`**（不是 macos），Apple Silicon 是 `aarch64`。
 * 写错一个字客户端就找不到条目、永远检测不到更新，而且**不报错**。
 *
 * 为何需要合并（UPDATER_MERGE_INTO）：Windows 与 mac 在**不同的 CI job** 里构建，
 * 各自只看得到自己平台的产物。若后跑的 job 直接覆写 updater.json，先跑那个平台的
 * 条目就没了——那个平台的用户会**静默**失去自动更新。所以支持先读已有 json 的
 * platforms、再叠加本平台条目。
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
// 先读这份已有 json 的 platforms 再叠加本平台条目（跨 job 合并用，见文件头注释）。
// 指向不存在的文件不报错，只提示——另一个平台的 job 可能构建失败了，
// 那时候应该能只发本平台，而不是跟着一起挂。
const MERGE_INTO = process.env.UPDATER_MERGE_INTO || null;

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
}
function warn(msg) {
  console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}

/**
 * 读一个产物目录，返回 { fileName, signature }；目录不存在或无匹配文件返回 null。
 * 签名缺失直接 fail：写出空签名的 updater.json 会在运行时校验失败、自动更新整条断掉，
 * 且毫无报错。宁可在构建期就红，也不发带病版本。
 */
function readArtifact({ dir, pick, label }) {
  const dirPath = path.join(BUNDLE_DIR, dir);
  if (!fs.existsSync(dirPath)) return null;
  const files = fs.readdirSync(dirPath);
  const pkgFile = files.find(pick);
  if (!pkgFile) return null;

  const sigFile = files.find((f) => f === `${pkgFile}.sig`);
  if (!sigFile) {
    fail(
      `找到 ${pkgFile} 但没有 .sig 签名文件（${label}）。\n` +
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

/** Windows：NSIS 安装包。 */
function findWindowsArtifact() {
  return readArtifact({
    dir: "nsis",
    label: "windows-x86_64",
    pick: (f) => f.endsWith(".exe") && !f.endsWith(".exe.sig"),
  });
}

/**
 * macOS：tauri-bundler 产出的是 `<name>.app.tar.gz`（updater 专用），不是 .dmg——
 * updater 的 install_inner 直接用 tar::Archive 解压它，所以必须指向 tar.gz。
 */
function findMacArtifact() {
  return readArtifact({
    dir: "macos",
    label: "darwin-aarch64",
    pick: (f) => f.endsWith(".app.tar.gz"),
  });
}

function readVersionFromConf() {
  const confPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
  if (!fs.existsSync(confPath)) fail(`找不到 tauri.conf.json: ${confPath}`);
  const conf = JSON.parse(fs.readFileSync(confPath, "utf-8"));
  if (!conf.version) fail("tauri.conf.json 中未找到 version 字段");
  return conf.version;
}

function buildDownloadUrl(tag, fileName) {
  // URL_TEMPLATE 优先：支持 Gitee 这种与 GitHub Release 拼法形状不同的镜像（见上方注释）。
  // 注意用 replaceAll 而非 replace：模板里 {tag} 可能出现不止一次（如 Gitee 模板
  // ".../raw/{tag}/releases/{tag}/{filename}"），单次 replace 只换第一处会留下未替换的 {tag}。
  return URL_TEMPLATE
    ? URL_TEMPLATE.replaceAll("{tag}", tag).replaceAll("{filename}", fileName)
    : `${GITHUB_RELEASE_BASE}/${tag}/${fileName}`;
}

function loadMergeBase() {
  if (!MERGE_INTO) return {};
  if (!fs.existsSync(MERGE_INTO)) {
    warn(`UPDATER_MERGE_INTO 指向的文件不存在，本次只写本平台条目：${MERGE_INTO}`);
    return {};
  }
  try {
    const base = JSON.parse(fs.readFileSync(MERGE_INTO, "utf-8"));
    const platforms = base.platforms || {};
    info(`已从 ${MERGE_INTO} 读入已有平台条目：${Object.keys(platforms).join(", ") || "(空)"}`);
    return platforms;
  } catch (e) {
    // 不 fail：对方 job 可能产出了一个损坏文件，不应该拖着本平台一起发不了。
    warn(`解析 UPDATER_MERGE_INTO 失败，本次只写本平台条目：${e.message}`);
    return {};
  }
}

function main() {
  const version = readVersionFromConf();
  const tag = process.env.GITHUB_RELEASE_TAG || `v${version}`;
  const notes = process.env.UPDATER_NOTES || `cc-bridge v${version}`;

  info(`仓库: ${REPO_OWNER}/${REPO_NAME}`);
  info(`版本: ${version}`);
  info(`Release Tag: ${tag}`);
  info(`扫描构建产物: ${BUNDLE_DIR}`);

  const platforms = loadMergeBase();

  const win = findWindowsArtifact();
  if (win) {
    platforms["windows-x86_64"] = {
      signature: win.signature,
      url: buildDownloadUrl(tag, win.fileName),
    };
    success(`windows-x86_64: ${win.fileName}`);
    info(`  下载 URL: ${platforms["windows-x86_64"].url}`);
  }

  const mac = findMacArtifact();
  if (mac) {
    // 只出 arm64（用户已定）。将来若改 universal，把 darwin-x86_64 也指向同一个包即可。
    platforms["darwin-aarch64"] = {
      signature: mac.signature,
      url: buildDownloadUrl(tag, mac.fileName),
    };
    success(`darwin-aarch64: ${mac.fileName}`);
    info(`  下载 URL: ${platforms["darwin-aarch64"].url}`);
  }

  if (Object.keys(platforms).length === 0) {
    fail(
      "未找到任何可发布的构建产物（nsis/*.exe 或 macos/*.app.tar.gz）。\n" +
        "请先运行 npm run build 构建应用。\n" +
        "确保 tauri.conf.json 中 bundle.createUpdaterArtifacts = true"
    );
  }

  const updaterJson = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };

  const distDir = path.join(ROOT, "dist");
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  const outputPath = path.join(distDir, OUTPUT_FILENAME);
  fs.writeFileSync(outputPath, JSON.stringify(updaterJson, null, 2), "utf-8");

  success(`已生成: ${outputPath}（平台：${Object.keys(platforms).join(", ")}）`);
  console.log(JSON.stringify(updaterJson, null, 2));
}

main();
