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
 * 🔴 这个分支**只放清单**，安装包走 Gitee 发行版附件（2026-11-15 改）。
 *   实测（v3.1.5 回填）：raw 对匿名访问有大小上限，
 *     cc-bridge_3.1.5_x64-setup.exe  8.08MB → 200
 *     cc-bridge.app.tar.gz          10.23MB → 403 `large file require login for access`
 *   客户端不可能登录 Gitee，所以把安装包塞进 raw 分支这条路对大产物**从根上不通**；
 *   而 Gitee 发行版附件实测 21MB 匿名可下（PastePanda v7.0.0 的 exe 完整 22,107,652B 拉完）。
 *   ⇒ 分支里只留 86KB 的清单（小文件不受限），二进制放 `releases/download/{tag}/{filename}`。
 *   Windows 包已经 8MB，涨过 10MB 只是时间问题，不能靠「现在还没超」侥幸。
 *
 * 🔴 latest/ 每次整份清空（与 PastePanda 的有意差异）。
 *   PastePanda 的 latest/ 同时住着桌面与手机两条独立发版线的 manifest，谁清空谁就删掉对端的
 *   第 1 更新源（它 2026-10-09 的真事故）。cc-bridge 只有一条发版线，清单文件名固定
 *   （updater-gitee.json），不涉及多线对撞；而清空 + `git add -A latest` 还负责一件事：
 *   把 2026-11-15 之前塞在分支里的 18MB 安装包**删掉**，不让它们继续占分支体积。
 *
 * 其余四条硬约束：
 *  1. **只许 fast-forward，绝不 force**。镜像同步拒绝非 FF 更新 ⇒ Gitee 停在旧 sha；而客户端
 *     读到一条「版本不比当前新」的旧 manifest 会直接判「已是最新」，后面的 GitHub 源一个都不试
 *     —— 一条旧 manifest 比 404 更毒（build.yml 原注释也写过这个坑）。
 *  2. **推之前把文件清单和体积打出来**：18MB 级产物是发布侧的主要风险来源。
 *  3. **四段验证**：GitHub sha == 推送 sha → Gitee 分支 sha == 推送 sha → raw 上的 version 与
 *     **内容哈希**都对得上（同版本重发时只比 version 会被边缘缓存骗过去，实际发生过）→
 *     每个安装包在 Gitee 发行版附件下真的可读。只验 manifest 会漏掉「清单好、exe 404」
 *     这一整类事故（PastePanda v7.1.1 就是这样让自动更新对所有用户失效的）。
 *     第 4 段按 `--tag` 拼 `releases/download/{tag}/{name}` 探测；**不给 --tag 就不做第 4 段**，
 *     绝不退回 raw 去探（那会把现在的平台限制重新当成「已验证」）。
 *  4. **本脚本不需要 GITEE_TOKEN**：它只往 GitHub 推分支；附件上传由 CI 那一步用 token 调 API
 *     完成（只调 API，不往 Gitee push 任何 git 引用）。Gitee 侧的分支仍由镜像搬运。
 *
 * 用法（在仓库根目录跑）：
 *   node desktop/scripts/publish-manifest-branch.mjs \
 *     --file desktop/dist/updater-gitee.json \
 *     --gitee-repo lzul/cc-bridge --tag v3.1.5
 *   --dry-run            只列出要发哪些文件，不 clone 不 push
 *   --no-verify-readback 跳过四段验证（只给调用方自己回读时用）
 *   --tag <vX.Y.Z>       第 4 段按 Gitee 发行版附件探测；传了安装包却不传它会直接报错
 *
 * 环境变量：GH_TOKEN / GITHUB_TOKEN（CI 传 secrets.GITHUB_TOKEN；本地取 gh auth token）
 *           GH_REPO（默认 lzlkyb/cc-bridge）、GITEE_REPOSITORY（默认 lzul/cc-bridge）
 *           GITEE_RELEASE_TAG（--tag 的环境变量形式，CI 用 github.ref_name）
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
 * Gitee 发行版附件的直链。安装包只在这里，不进 raw 分支 —— raw 对匿名访问有大小上限，
 * 超过就 403 `large file require login for access`，而客户端没有登录态（见文件头实测数据）。
 */
export const giteeReleaseAssetUrl = (repo, tag, name) =>
  `https://gitee.com/${repo}/releases/download/${tag}/${name}`;

/**
 * 四段验证的判定（纯函数）：推下去 ≠ 客户端用得了。
 * assets 是 { 文件名: boolean }，空对象表示这次只发 manifest。
 */
export function verifyVerdict({
  pushedSha,
  ghSha,
  giteeSha,
  version,
  expectedVersion,
  digest,
  expectedDigest,
  assets = {},
}) {
  if (ghSha !== pushedSha) return "github";
  if (giteeSha !== pushedSha) return "mirror";
  if (version !== expectedVersion) return "manifest";
  // 同版本重发时 version 比不出来，必须比内容。不给 expectedDigest 就跳过（单测/老调用方）。
  if (expectedDigest && digest !== expectedDigest) return "manifest";
  if (Object.values(assets).some((v) => !v)) return "asset";
  return "ok";
}

/** 每一段各自的修法提示：失败时别让人去猜是路径错了、镜像没搬，还是 CDN 还在回旧内容。 */
export const VERIFY_STAGE_HINT = {
  github: "GitHub 的 releases 分支 sha 没跟上——push 其实没生效（查 contents: write / 分支保护 / 非 FF 被拒）",
  mirror: "Gitee 镜像还没把这条分支搬过去（同步由 GitHub push 触发，实测 4–11s；分叉时最长 260s）",
  manifest: "Gitee 分支 sha 已一致，但 raw 边缘还回旧内容（版本号或内容哈希对不上，实测传播 20–100s）",
  asset:
    "清单可读，但 Gitee 发行版里读不到安装包（releases/download/{tag}/{name}）——客户端会卡在下载 404/403，" +
    "查附件是否真上传成功（API 叫 attach_files，回读字段却叫 assets）、tag 是否已在 Gitee 存在",
};

/**
 * git 子进程的运行环境：剔掉一切会改变「这个 git 命令作用于哪个仓库」的变量。
 * 🔴 2026-11-24 事故：git 从 linked worktree 推 main 时，会给 pre-push 钩子注入**绝对路径的
 * GIT_DIR**（普通 clone 不注入 —— .git 可发现，而 worktree 的 .git 是个文件，不注入钩子
 * 找不到仓库）。钩子跑 `npm test` → vitest → 本脚本 e2e 测试里 spawnSync("git", …, {
 * cwd: 临时clone }) 全部被重定向到钩子所在仓库：在真实仓库里误建孤儿 releases 分支、
 * 还朝真实 GitHub 远端发起 push（被非 FF 拒绝）⇒ 测试变红，而代码本身没有错。
 * 同理适用于任何带 ambient GIT_DIR 的调用方（IDE 终端、被包在别的 git 上下文里的脚本）：
 * 这个脚本的唯一出口是 GitHub 的 releases 分支，被重定向等于把清单发进错误的仓库。
 */
const REPO_SCOPED_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_PARAMETERS",
];

export function gitSubprocessEnv(base = process.env) {
  const env = { ...base };
  for (const key of REPO_SCOPED_GIT_ENV) delete env[key];
  // git 的临时配置注入机制（GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n/VALUE_n）一并剔掉：
  // 留着等于让 ambient 上下文往这次 clone/push 里塞配置（remote 覆盖、safe.directory……）。
  const injected = Number(env.GIT_CONFIG_COUNT);
  if (Number.isFinite(injected) && injected > 0) {
    for (let i = 0; i < injected; i++) {
      delete env[`GIT_CONFIG_KEY_${i}`];
      delete env[`GIT_CONFIG_VALUE_${i}`];
    }
  }
  delete env.GIT_CONFIG_COUNT;
  return env;
}

function runGit(args, label, { cwd, allowFail = false } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: gitSubprocessEnv(),
  });
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

    // 分支里只留清单；安装包走 Gitee 发行版附件（raw 大文件 403，见文件头实测）。
    // 清空 + `add -A` 仍要做：它负责把历史版本塞在分支里的安装包一并删掉。
    rmSync(path.join(dir, MANIFEST_DIR), { recursive: true, force: true });
    mkdirSync(path.join(dir, MANIFEST_DIR), { recursive: true });

    const manifestFiles = planned.filter((p) => p.name === MANIFEST_NAME);
    const binaryFiles = planned.filter((p) => p.name !== MANIFEST_NAME);
    for (const p of manifestFiles) {
      const kb = statSync(p.src).size / 1024;
      copyFileSync(p.src, path.join(dir, MANIFEST_DIR, p.name));
      info(`  - ${MANIFEST_DIR}/${p.name}  ${kb.toFixed(1)} KB（进分支，镜像搬到 Gitee raw）`);
    }
    if (binaryFiles.length) {
      const mb = binaryFiles.reduce((n, p) => n + statSync(p.src).size, 0) / 1024 / 1024;
      info(`另 ${binaryFiles.length} 个安装包合计 ${mb.toFixed(2)} MB：不进分支，走 Gitee 发行版附件`);
      for (const p of binaryFiles) info(`  ~ releases/download/{tag}/${p.name}`);
    }
    if (manifestFiles.length === 0) {
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
 * 读 raw manifest 的 version **与内容哈希**。
 * 🔴 为什么要哈希：Gitee raw 有边缘缓存，而第 3 段过去只比 version —— 同一版本重发时
 * 旧内容也「version 对得上」，会直接判通过（2026-11-15 回填 v3.1.5 就是这么被蒙过去的：
 * 四段全绿，但 raw 上还是指向 gh-proxy/raw 的旧清单，25s 后才传播成新的）。
 * 发版正常会涨版本号，所以这只是兜底；但「绿了其实没生效」正是这条链路最贵的故障。
 */
export async function readRawManifest(url) {
  try {
    const r = await globalThis.fetch(url, { redirect: "follow", cache: "no-store" });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    let version = null;
    try {
      version = JSON.parse(buf.toString("utf8")).version ?? null;
    } catch {
      // 内容还不是 JSON（边缘回了个错误页）：版本留空，由调用方判失败
    }
    return { version, digest: createHash("sha256").update(buf).digest("hex") };
  } catch {
    return null;
  }
}

/** 本地文件的内容哈希，用来和第 3 段读到的 raw 内容逐字节比。 */
export const fileDigest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

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
 * 四段验证：GitHub sha → Gitee 分支 sha → raw version → 全部安装包在发行版附件下可读。
 * 每段失败都打印「卡在哪一段」，不再一句「读不到」把四种成因混成一团。
 * `tag` 只用于第 4 段；有 assets 却没给 tag 时直接报错，不退回 raw 假装验过。
 */
export async function verifyChannel({
  ghRepo,
  giteeRepo,
  tag,
  pushedSha,
  expectedVersion,
  expectedDigest,
  assets = [],
  waits = DEFAULT_RETRY_WAITS,
}) {
  if (assets.length > 0 && !tag) {
    throw new Error(
      "要验证安装包直链必须传 --tag：安装包已改走 Gitee 发行版附件（releases/download/{tag}/），" +
        "没有 tag 就拼不出地址。退回 raw 探测是错的 —— 大文件在 raw 下恒 403。",
    );
  }
  const manifestUrl = giteeRawUrl(giteeRepo, MANIFEST_NAME);
  const assetUrl = (name) => giteeReleaseAssetUrl(giteeRepo, tag, name);
  let last = null;
  for (let i = 0; i <= waits.length; i++) {
    const ghSha = remoteHeadSha(`https://github.com/${ghRepo}.git`);
    const giteeSha = remoteHeadSha(`https://gitee.com/${giteeRepo}.git`);
    const raw = await readRawManifest(manifestUrl);
    const version = raw?.version ?? null;
    const digest = raw?.digest ?? null;
    const assetState = {};
    for (const n of assets) assetState[n] = await probeAsset(assetUrl(n));
    const stage = verifyVerdict({
      pushedSha,
      ghSha,
      giteeSha,
      version,
      expectedVersion,
      digest,
      expectedDigest,
      assets: assetState,
    });
    last = { stage, ghSha, giteeSha, version, digest, assets: assetState };
    if (stage === "ok") {
      ok(
        `通道四段全绿：GitHub=${ghSha}｜Gitee=${giteeSha}｜version=${version}` +
          `｜${assets.length} 个安装包在发行版附件下可读${tag ? `（${tag}）` : ""}`,
      );
      return last;
    }
    if (i === waits.length) break;
    const failed = Object.entries(assetState).filter(([, v]) => !v).map(([n]) => n);
    // 同版本重发时内容可能是旧的（边缘缓存）—— 单独标出来，否则「version 对得上」会骗人
    const contentNote =
      expectedDigest && digest !== expectedDigest
        ? ` 内容哈希=${String(digest).slice(0, 8)}≠期望${expectedDigest.slice(0, 8)}`
        : "";
    info(
      `验证第 ${i + 1} 轮卡在「${VERIFY_STAGE_HINT[stage]}」` +
        `（github=${ghSha ?? "读不到"} gitee=${giteeSha ?? "读不到"} raw=${version ?? "读不到"}` +
        `${contentNote}${failed.length ? ` 直链不可读=${failed.join(",")}` : ""}），${waits[i]}s 后重试`,
    );
    await sleep(waits[i] * 1000);
  }
  throw new Error(
    `验证未通过，最后卡在「${VERIFY_STAGE_HINT[last.stage]}」\n` +
      `  github=${last.ghSha ?? "读不到"}｜gitee=${last.giteeSha ?? "读不到"}｜raw=${last.version ?? "读不到"}` +
      `｜内容哈希=${String(last.digest).slice(0, 12)}（期望 ${String(expectedDigest).slice(0, 12)}）` +
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
  const assets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") {
      const value = argv[++i];
      if (!value) throw new Error("--file 后面缺文件路径");
      files.push(value);
    }
    // --asset 只登记「清单里引用了、要去发行版附件下探测」的文件名，不进分支、不复制。
    // 安装包已经单独上传，清单步骤只需要按名字验它可读。
    if (argv[i] === "--asset") {
      const value = argv[++i];
      if (!value) throw new Error("--asset 后面缺文件名");
      assets.push(value);
    }
  }
  const at = argv.indexOf("--gitee-repo");
  const tagAt = argv.indexOf("--tag");
  return {
    files,
    assets,
    giteeRepo: (at >= 0 ? argv[at + 1] : "") || process.env.GITEE_REPOSITORY || DEFAULT_GITEE_REPO,
    ghRepo: process.env.GH_REPO || DEFAULT_GH_REPO,
    // 第 4 段探的是发行版附件地址，需要 tag；CI 传 github.ref_name，本地可显式给。
    tag: ((tagAt >= 0 ? argv[tagAt + 1] : "") || process.env.GITEE_RELEASE_TAG || "").trim(),
    verify: !argv.includes("--no-verify-readback"),
    dryRun: argv.includes("--dry-run"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { files, assets: assetNames, giteeRepo, ghRepo, tag, verify, dryRun } = parseArgs(argv);
  const planned = planFiles(files);
  const manifest = planned.find((p) => p.name === MANIFEST_NAME);
  if (!manifest) throw new Error(`缺少 ${MANIFEST_NAME} —— 客户端就是读它，缺了等于整个国内通道白做`);
  // 要验的附件 = 本次随行传进来的安装包 + --asset 登记的（CI 里安装包单独上传，只登记名字）。
  // 名字必须与 planFiles 同规则校验，否则能把任意路径拼进探测 URL。
  for (const n of assetNames) {
    if (!/^[A-Za-z0-9._-]+$/.test(n) || n === "." || n === "..") {
      throw new Error(`--asset 文件名不合形态（只允许字母数字 . _ -）：${n}`);
    }
  }
  const assets = [...new Set([...planned.filter((p) => p.name !== MANIFEST_NAME).map((p) => p.name), ...assetNames])];
  info(`目标：${ghRepo}@${MANIFEST_BRANCH}/${MANIFEST_DIR}/｜镜像=${giteeRepo}｜文件=${planned.map((p) => p.name).join(", ")}`);
  const token = ghToken();
  if (!token && !dryRun) throw new Error("拿不到 GitHub 令牌（CI 传 secrets.GITHUB_TOKEN，本地用 gh auth token）");

  const res = publishManifestBranch({ repo: ghRepo, token, files: planned.map((p) => p.src), dryRun });
  if (res.dryRun) return res;
  if (!verify) {
    info("--no-verify-readback：跳过四段验证（由调用方自己回读时使用）");
    return res;
  }
  return verifyChannel({
    ghRepo,
    giteeRepo,
    tag,
    pushedSha: res.sha,
    expectedVersion: readManifestVersion(manifest.src),
    // 同版本重发时只看 version 会被边缘缓存骗过去，所以再比一次内容哈希
    expectedDigest: fileDigest(manifest.src),
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
