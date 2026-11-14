#!/usr/bin/env node
/**
 * publish-manifest-branch.mjs — 国内加速通道（Gitee raw）的唯一发布出口。
 *
 * 客户端把第 1 更新源写死在二进制里：
 *   https://gitee.com/lzul/cc-bridge/raw/releases/latest/updater-gitee.json
 * 见 desktop/src-tauri/src/commands/update.rs:197,206。改 tauri 配置救不了已经装上的用户，
 * 所以这里不改客户端，只保证「那个地址背后一直有本次发版的文件」。
 *
 * 🔴 为什么分支要建在 GitHub 上（2026-11-11 改道，参照 PastePanda 2026-10-10 的实测定性）：
 *   Gitee 的「管理 → 仓库镜像管理」是 Pull 方向镜像（GitHub lzlkyb/cc-bridge → Gitee lzul/cc-bridge），
 *   同步的是**整个分支集合**，并带「删除在远程仓库中不存在的分支和标签」。以前 releases
 *   是手工建在 Gitee 上的孤儿分支 ⇒ 上游 GitHub 没有它 ⇒ 每推一次 main 就被剪一次。
 *   v3.1.5 实测：19:49 CI 推 5 文件 / 18.03MB / 522s，raw 200、version=3.1.5、两平台齐全，
 *   打印「✅ 已镜像到 Gitee」；20:26 main push（235a07a）触发同步，releases 分支消失 → 404。
 *   当时不是假绿，是**后来被剪掉的**。现在把分支建在 GitHub：镜像不剪它，还替我们搬到 Gitee
 *   （PastePanda 实测同步 4–11s，raw 边缘 20–100s，分支分叉时强制对齐窗口 260s）。
 *
 * 🔴 与 PastePanda 的唯一有意差异：**这里每次清空 latest/**。
 *   PastePanda 的 latest/ 同时住着桌面与手机两条独立发版线的 manifest，谁清空谁就删掉对端的
 *   第 1 更新源（它 2026-10-09 的真事故）。cc-bridge 只有一条发版线，一次把 Windows exe/sig
 *   与 mac tar.gz/sig 全部推齐，而产物文件名带版本号 ⇒ 不清空就会残留上一版安装包、仓库随
 *   发版次数无限膨胀。清空后必须 `git add -A latest` 才能把删除一并提交。
 *
 * 其余四条硬约束与 PastePanda 一致：
 *  1. **只许 fast-forward，绝不 force**。镜像同步拒绝非 FF 更新 ⇒ Gitee 停在旧 sha；而客户端
 *     读到一条「版本不比当前新」的旧 manifest 会直接判「已是最新」，后面的 GitHub 源一个都不试
 *     —— 一条旧 manifest 比 404 更毒（build.yml 原注释也写过这个坑）。
 *  2. **推之前把文件清单和体积打出来**：18MB 级产物是发布侧的主要风险来源。
 *  3. **四段验证**：GitHub sha == 推送 sha → Gitee 分支 sha == 推送 sha → raw version 对得上
 *     → latest/ 里每个安装包的直链真的可读。只验 manifest 会漏掉「清单好、exe 404」这一整类事故
 *     （PastePanda v7.1.1 就是这样让自动更新对所有用户失效的）。
 *  4. **不再需要 GITEE_TOKEN**：出境只往 GitHub 推，用 GITHUB_TOKEN；Gitee 侧由镜像搬运。
 *
 * 用法（在仓库根目录跑）：
 *   node desktop/scripts/publish-manifest-branch.mjs \
 *     --file dist-out/cc-bridge_3.1.5_x64-setup.exe \
 *     --file dist-out/cc-bridge_3.1.5_x64-setup.exe.sig \
 *     --file desktop/dist/updater-gitee.json \
 *     --gitee-repo lzul/cc-bridge
 *   --dry-run            只列出要发哪些文件，不 clone 不 push
 *   --no-verify-readback 跳过四段验证（只给调用方自己回读时用）
 *
 * 环境变量：GH_TOKEN / GITHUB_TOKEN（CI 传 secrets.GITHUB_TOKEN；本地取 gh auth token）
 *           GH_REPO（默认 lzlkyb/cc-bridge）、GITEE_REPOSITORY（默认 lzul/cc-bridge）
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const MANIFEST_BRANCH = "releases";
export const MANIFEST_DIR = "latest";
export const DEFAULT_GH_REPO = "lzlkyb/cc-bridge";
export const DEFAULT_GITEE_REPO = "lzul/cc-bridge";
/** 客户端认的那份清单，文件名同时也是四段验证里比 version 的对象。 */
export const MANIFEST_NAME = "updater-gitee.json";

/**
 * 镜像同步 + raw 边缘传播的实测窗口：正常 11s / 20–100s，分叉强制对齐 260s。
 * 累计 630s = 最坏窗口的 2 倍余量（沿用 PastePanda 实测档）。
 */
export const DEFAULT_RETRY_WAITS = [30, 60, 90, 120, 150, 180];

const info = (m) => console.log(`\x1b[36m[manifest-branch]\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m[OK]\x1b[0m ${m}`);

/** clone/push 用的带令牌地址。令牌只进请求，不进任何一行日志。 */
export function githubGitUrl(repo, token) {
  if (!repo || !token) throw new Error("拼 GitHub 远端地址需要 repo 与 token 两者");
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/** 把 URL / git 输出里的凭据打掉，失败信息才敢直接打印。 */
export function sanitizeRemote(text) {
  return String(text).replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@");
}

/**
 * 待发布文件：只认 basename（防止 --file ../../xxx 之类的路径穿越），落到 latest/ 下同名。
 * 相对路径按**当前工作目录**解析，不按脚本所在目录 —— CI 在仓库根目录调用，
 * 产物路径是 dist-out/... 与 desktop/dist/...，不能解析到 desktop/ 底下。
 */
export function planFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("没有指定要发布的文件");
  const seen = new Set();
  return files.map((f) => {
    const raw = String(f);
    const name = path.basename(raw);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      throw new Error(`产物文件名不合形态（只允许字母数字 . _ -）：${name}`);
    }
    if (seen.has(name)) throw new Error(`同名产物传了两次：${name}`);
    seen.add(name);
    return { src: path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw), name };
  });
}

/**
 * 推送参数：**没有 -f / --force / --no-verify**。
 * 导出去给守卫当靶子 —— 把 force 加回来时守卫要变红。
 */
export function pushArgs(branch = MANIFEST_BRANCH) {
  return ["push", "origin", branch];
}

/** 清空 latest/ 后必须把删除也提交，所以用 -A；范围用 -- 钉死在 latest/ 里。 */
export function addArgs(dir = MANIFEST_DIR) {
  return ["add", "-A", "--", dir];
}

/** Gitee raw 上一份文件的直链（与客户端 updater-gitee.json 里拼出的 URL 同形）。 */
export const giteeRawUrl = (repo, name) =>
  `https://gitee.com/${repo}/raw/${MANIFEST_BRANCH}/${MANIFEST_DIR}/${name}`;

/**
 * 四段验证的判定（纯函数）：推下去 ≠ 客户端用得了。
 * assets 是 { 文件名: boolean }，空对象表示这次只发 manifest。
 */
export function verifyVerdict({ pushedSha, ghSha, giteeSha, version, expectedVersion, assets = {} }) {
  if (ghSha !== pushedSha) return "github";
  if (giteeSha !== pushedSha) return "mirror";
  if (version !== expectedVersion) return "manifest";
  if (Object.values(assets).some((v) => !v)) return "asset";
  return "ok";
}

/** 每一段各自的修法提示：失败时别让人去猜是路径错了、镜像没搬，还是 CDN 还在回旧内容。 */
export const VERIFY_STAGE_HINT = {
  github: "GitHub 的 releases 分支 sha 没跟上——push 其实没生效（查 contents: write / 分支保护 / 非 FF 被拒）",
  mirror: "Gitee 镜像还没把这条分支搬过去（同步由 GitHub push 触发，实测 4–11s；分叉时最长 260s）",
  manifest: "Gitee 分支 sha 已一致，但 raw 边缘还回旧内容或版本号不对（实测传播 20–100s）",
  asset: "清单可读，但 latest/ 里的安装包直链读不到——客户端会卡在下载 404，查 Gitee 是否同步了二进制",
};

function runGit(args, label, { cwd, allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = sanitizeRemote(`${r.stdout || ""}${r.stderr || ""}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${label} 失败（exit ${r.status}）：\n${out.slice(0, 2000)}`);
  }
  return { status: r.status, out, stdout: sanitizeRemote(r.stdout || "") };
}

/**
 * clone releases 分支；分支不存在时从默认分支建孤儿分支（只在 GitHub 侧，Gitee 侧不再手工建）。
 * unborn HEAD 上的 reset --hard 是必需的：不清索引的话孤儿分支会把 main 全部源码一起提交。
 */
function prepareWorktree(url, dir) {
  const first = runGit(["clone", "--depth", "1", "--branch", MANIFEST_BRANCH, url, dir], `clone ${MANIFEST_BRANCH}`, {
    allowFail: true,
  });
  if (first.status === 0) return false;
  if (!/Remote branch|not found in upstream|did not match any file/i.test(first.out)) {
    throw new Error(
      `clone ${MANIFEST_BRANCH} 失败，且不是「分支不存在」这一类（先查令牌写权限与仓库路径 ${sanitizeRemote(url)}）：\n${first.out.slice(0, 1500)}`,
    );
  }
  info(`${MANIFEST_BRANCH} 分支不存在，从默认分支建孤儿分支重建（只建在 GitHub 上）`);
  rmSync(dir, { recursive: true, force: true });
  runGit(["clone", "--depth", "1", url, dir], "clone 默认分支");
  runGit(["-C", dir, "checkout", "--orphan", MANIFEST_BRANCH], "创建孤儿分支");
  runGit(["-C", dir, "reset", "--hard"], "清空孤儿分支索引");
  return true;
}

/**
 * 主流程：clone → 清空 latest/ → 复制本次全部产物 → 提交 → FF push → 返回新 sha。
 * `nothing to commit` 不算失败：内容与分支上一致时直接进验证段。
 * `remote` 只给「用本地 bare 仓库端到端彩排」的测试用；生产调用方一律走 repo + token。
 */
export function publishManifestBranch({ repo, token, files, workDir, identity, remote, dryRun = false }) {
  const planned = planFiles(files);
  if (dryRun) {
    planned.forEach((p) => info(`DRY_RUN：会把 ${p.src} → ${MANIFEST_DIR}/${p.name}`));
    return { sha: null, files: planned, dryRun: true };
  }
  const url = remote ?? githubGitUrl(repo, token);
  const dir = workDir ?? mkdtempSync(path.join(tmpdir(), "ccb-manifest-branch-"));
  try {
    prepareWorktree(url, dir);

    // cc-bridge 单发版线、产物名带版本号：必须整份替换，否则旧 exe 残留 + 仓库无限膨胀。
    // 与 PastePanda「绝不清空 latest/」的取舍不同，原因见文件头。
    rmSync(path.join(dir, MANIFEST_DIR), { recursive: true, force: true });
    mkdirSync(path.join(dir, MANIFEST_DIR), { recursive: true });

    for (const p of planned) {
      const size = statSync(p.src).size;
      copyFileSync(p.src, path.join(dir, MANIFEST_DIR, p.name));
      info(`  - ${MANIFEST_DIR}/${p.name}  ${(size / 1024 / 1024).toFixed(2)} MB`);
    }
    const total = planned.reduce((n, p) => n + statSync(p.src).size, 0);
    info(`本次共 ${planned.length} 个文件，合计 ${(total / 1024 / 1024).toFixed(2)} MB（推到 GitHub，Gitee 由镜像搬运）`);
    if (!planned.some((p) => p.name === MANIFEST_NAME)) {
      throw new Error(`缺少 ${MANIFEST_NAME} —— 客户端就是读它，缺了等于整个国内通道白做`);
    }

    runGit(addArgs(), "git add", { cwd: dir });
    const who = identity ?? { email: "ci@cc-bridge.local", name: "cc-bridge-ci" };
    const commit = runGit(
      [
        "-c", `user.email=${who.email}`,
        "-c", `user.name=${who.name}`,
        "commit", "-m", `release: mirror ${MANIFEST_DIR} to Gitee channel`,
      ],
      "git commit",
      { cwd: dir, allowFail: true },
    );
    const head = runGit(["rev-parse", "HEAD"], "git rev-parse", { cwd: dir }).stdout.trim();
    if (/nothing (to commit|anything staged)/i.test(commit.out)) {
      ok(`内容与 ${MANIFEST_BRANCH} 分支上的一致（nothing to commit），跳过 push：sha=${head}`);
      return { sha: head, files: planned, pushed: false };
    }
    if (commit.status !== 0) throw new Error(`git commit 失败：\n${commit.out.slice(0, 1500)}`);

    const push = runGit(pushArgs(), "git push", { cwd: dir, allowFail: true });
    if (push.status !== 0) {
      throw new Error(
        `push ${MANIFEST_BRANCH} 失败。这里**不用 force**：镜像同步拒绝非 FF 的分支更新，` +
          `force 会让 Gitee 停在旧 sha 上、客户端读到一条旧 manifest（比 404 更毒）。\n` +
          `先判读：\n${push.out.slice(0, 1500)}`,
      );
    }
    ok(`已 FF 推送 ${repo ?? "本地彩排仓"}@${MANIFEST_BRANCH}：sha=${head}`);
    return { sha: head, files: planned, pushed: true };
  } finally {
    // 临时 clone 的 .git/config 里带着令牌，用完即删
    if (!workDir) rmSync(dir, { recursive: true, force: true });
  }
}

/** 匿名读一条分支的 sha；读不到返回 null（分支不存在或连不上，两者都由调用方结合上下文判）。 */
export function remoteHeadSha(remoteUrl, branch = MANIFEST_BRANCH) {
  const r = runGit(["ls-remote", "--heads", remoteUrl, branch], "git ls-remote", { allowFail: true });
  if (r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.includes(`refs/heads/${branch}`));
  return line ? line.split(/\s+/)[0] : null;
}

/** 读一份 raw manifest 的 version；读不到返回 null，不编造「它不存在」。 */
export async function readRawVersion(url) {
  try {
    const r = await globalThis.fetch(url, { redirect: "follow" });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * 探一份安装包直链：只看响应头，**不读 body**（否则每轮把 18MB 拉一遍）。
 * 接受 200/206 等 2xx/3xx 最终态，但拒绝 HTML —— Gitee 的登录页/错误页也是 200。
 */
export async function probeAsset(url) {
  try {
    const r = await globalThis.fetch(url, { redirect: "follow", headers: { Range: "bytes=0-63" } });
    const good = r.status >= 200 && r.status < 400 &&
      !/text\/html/i.test(r.headers.get("content-type") || "");
    await r.body?.cancel().catch(() => {});
    return good;
  } catch {
    return false;
  }
}

/**
 * 四段验证：GitHub sha → Gitee 分支 sha → raw version → 全部安装包直链。
 * 每段失败都打印「卡在哪一段」，不再一句「读不到」把四种成因混成一团。
 */
export async function verifyChannel({ ghRepo, giteeRepo, pushedSha, expectedVersion, assets = [], waits = DEFAULT_RETRY_WAITS }) {
  const manifestUrl = giteeRawUrl(giteeRepo, MANIFEST_NAME);
  let last = null;
  for (let i = 0; i <= waits.length; i++) {
    const ghSha = remoteHeadSha(`https://github.com/${ghRepo}.git`);
    const giteeSha = remoteHeadSha(`https://gitee.com/${giteeRepo}.git`);
    const version = await readRawVersion(manifestUrl);
    const assetState = {};
    for (const n of assets) assetState[n] = await probeAsset(giteeRawUrl(giteeRepo, n));
    const stage = verifyVerdict({ pushedSha, ghSha, giteeSha, version, expectedVersion, assets: assetState });
    last = { stage, ghSha, giteeSha, version, assets: assetState };
    if (stage === "ok") {
      ok(`通道四段全绿：GitHub=${ghSha}｜Gitee=${giteeSha}｜version=${version}｜${assets.length} 个安装包直链可读`);
      return last;
    }
    if (i === waits.length) break;
    const failed = Object.entries(assetState).filter(([, v]) => !v).map(([n]) => n);
    info(
      `验证第 ${i + 1} 轮卡在「${VERIFY_STAGE_HINT[stage]}」` +
        `（github=${ghSha ?? "读不到"} gitee=${giteeSha ?? "读不到"} raw=${version ?? "读不到"}` +
        `${failed.length ? ` 直链不可读=${failed.join(",")}` : ""}），${waits[i]}s 后重试`,
    );
    await sleep(waits[i] * 1000);
  }
  throw new Error(
    `验证未通过，最后卡在「${VERIFY_STAGE_HINT[last.stage]}」\n` +
      `  github=${last.ghSha ?? "读不到"}｜gitee=${last.giteeSha ?? "读不到"}｜raw=${last.version ?? "读不到"}` +
      `｜期望 sha=${pushedSha} version=${expectedVersion}\n` +
      `  直链=${JSON.stringify(last.assets)}`,
  );
}

function ghToken() {
  const fromEnv = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function readManifestVersion(src) {
  const j = JSON.parse(readFileSync(src, "utf8"));
  if (!j.version) throw new Error(`${path.basename(src)} 里没有 version 字段，验证段没法比对`);
  return j.version;
}

/**
 * 命令行解析。空值一律回落到默认：CI 里 secret 未配时是**空串**，会被当作一个参数传进来；
 * 直接拿去拼 URL 会变成 https://gitee.com//raw/... ⇒ 404 ⇒ 把一次已经 FF 成功的发布判成红。
 */
export function parseArgs(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") {
      const value = argv[++i];
      if (!value) throw new Error("--file 后面缺文件路径");
      files.push(value);
    }
  }
  const at = argv.indexOf("--gitee-repo");
  return {
    files,
    giteeRepo: (at >= 0 ? argv[at + 1] : "") || process.env.GITEE_REPOSITORY || DEFAULT_GITEE_REPO,
    ghRepo: process.env.GH_REPO || DEFAULT_GH_REPO,
    verify: !argv.includes("--no-verify-readback"),
    dryRun: argv.includes("--dry-run"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { files, giteeRepo, ghRepo, verify, dryRun } = parseArgs(argv);
  const planned = planFiles(files);
  const manifest = planned.find((p) => p.name === MANIFEST_NAME);
  if (!manifest) throw new Error(`缺少 ${MANIFEST_NAME} —— 客户端就是读它，缺了等于整个国内通道白做`);
  info(`目标：${ghRepo}@${MANIFEST_BRANCH}/${MANIFEST_DIR}/｜镜像=${giteeRepo}｜文件=${planned.map((p) => p.name).join(", ")}`);
  const token = ghToken();
  if (!token && !dryRun) throw new Error("拿不到 GitHub 令牌（CI 传 secrets.GITHUB_TOKEN，本地用 gh auth token）");

  const res = publishManifestBranch({ repo: ghRepo, token, files: planned.map((p) => p.src), dryRun });
  if (res.dryRun) return res;
  if (!verify) {
    info("--no-verify-readback：跳过四段验证（由调用方自己回读时使用）");
    return res;
  }
  const assets = planned.filter((p) => p.name !== MANIFEST_NAME).map((p) => p.name);
  return verifyChannel({
    ghRepo,
    giteeRepo,
    pushedSha: res.sha,
    expectedVersion: readManifestVersion(manifest.src),
    assets,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${e?.message ?? e}`);
    console.error(`::error title=国内加速通道发布::${String(e?.message ?? e).replace(/\n/g, " ")}`);
    process.exit(1);
  });
}
