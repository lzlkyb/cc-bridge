import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITEE_REPO,
  DEFAULT_GH_REPO,
  MANIFEST_BRANCH,
  MANIFEST_DIR,
  MANIFEST_NAME,
  VERIFY_STAGE_HINT,
  addArgs,
  giteeRawUrl,
  githubGitUrl,
  parseArgs,
  planFiles,
  publishManifestBranch,
  pushArgs,
  sanitizeRemote,
  verifyVerdict,
} from "./publish-manifest-branch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

/**
 * 这批守卫钉的是「2026-11-11 改道」之后不许退回去的形态。
 * 元凶不是推断：v3.1.5 的 CI 当时真的把 releases 分支推上了 Gitee 并验过 raw 200，
 * 20:26 一次 main push 触发 Gitee 镜像同步，把上游不存在的那条分支剪掉，第 1 更新源 404。
 * 所以「不许再往 Gitee 推分支」必须由机器把关，不能只写在注释里。
 */
describe("CI：国内通道只从 GitHub 的 releases 分支出境", () => {
  const workflow = read(".github", "workflows", "build.yml");
  const pusher = read("desktop", "scripts", "publish-manifest-branch.mjs");
  // 按步骤切片再断言。全文匹配会被别处同形态的行满足（其它步骤也有 GITHUB_TOKEN /
  // continue-on-error），真把本步骤的 env 删掉照样绿 —— 守卫要按「这一步还在不在」写。
  const channelStep = workflow
    .split(/(?=^ {6}- name: )/m)
    .find((s) => s.includes("发布国内加速通道"));

  it("国内通道那一步本身存在（切片解析不到就说明整步被删了）", () => {
    expect(channelStep).toBeTruthy();
  });

  it("workflow 里不再出现任何往 Gitee 推分支的写法", () => {
    expect(workflow, "又出现 Gitee 写令牌了 —— 出境只该用 GITHUB_TOKEN").not.toMatch(/GITEE_TOKEN/);
    expect(workflow, "又出现 oauth2 的 Gitee 远端地址了").not.toMatch(/oauth2:[^\n]*gitee\.com/);
    expect(workflow, "又出现 clone Gitee 仓库了 —— 那条分支会被镜像剪掉").not.toMatch(/git clone[^\n]*gitee\.com/);
    expect(workflow, "又出现往 Gitee push releases 了").not.toMatch(/push[^\n]*origin[^\n]*releases/);
  });

  it("国内通道那一步仍真的在发（守卫不是靠删掉整步变绿的）", () => {
    expect(channelStep).toMatch(/publish-manifest-branch\.mjs/);
    expect(channelStep).toMatch(/node @nodeArgs/);
    expect(channelStep).toMatch(/GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    expect(channelStep).toMatch(/GH_REPO: \$\{\{ github\.repository \}\}/);
    expect(channelStep).toMatch(/GITEE_REPOSITORY: \$\{\{ secrets\.GITEE_REPOSITORY \}\}/);
    expect(channelStep).toMatch(/continue-on-error: true/);
    // 清单生成步骤也还在，否则通道会「发了但没有清单」。
    expect(workflow).toMatch(/UPDATER_OUTPUT_FILENAME: "updater-gitee\.json"/);
  });

  it("唯一出口里：FF-only、清空 latest/、四段验证三件都在", () => {
    expect(pusher).toMatch(/export function publishManifestBranch/);
    expect(pusher).toMatch(/rmSync\(path\.join\(dir, MANIFEST_DIR\)/);
    expect(pusher).toMatch(/addArgs\(\)/);
    expect(pusher).toMatch(/verifyChannel/);
    for (const stage of ["github", "mirror", "manifest", "asset"]) {
      expect(VERIFY_STAGE_HINT, `四段验证少了 ${stage} 段的提示`).toHaveProperty(stage);
    }
  });
});

describe("纯函数：路径、参数与判定", () => {
  it("planFiles 只认 basename，且拒绝路径穿越 / 非法字符 / 重名", () => {
    const one = planFiles(["dist-out/setup.exe"]);
    expect(one[0].name).toBe("setup.exe");
    expect(one[0].src).toBe(path.resolve(process.cwd(), "dist-out/setup.exe"));

    // 传带目录的路径也不许把目录带进 latest/
    expect(planFiles(["a/b/c/updater-gitee.json"])[0].name).toBe("updater-gitee.json");
    // 路径穿越不构成威胁：落到分支里的只有 basename，目录层级不会跟过去。
    expect(planFiles(["../../etc/passwd"])[0].name).toBe("passwd");
    expect(() => planFiles(["../evil name.exe"])).toThrow(/不合形态/);
    expect(() => planFiles(["a.exe", "b/a.exe"])).toThrow(/传了两次/);
    expect(() => planFiles([])).toThrow(/没有指定/);
  });

  it("push 只许 fast-forward：不带 -f / --force / --no-verify", () => {
    const args = pushArgs();
    expect(args).toEqual(["push", "origin", MANIFEST_BRANCH]);
    for (const bad of ["-f", "--force", "--no-verify"]) expect(args).not.toContain(bad);
  });

  it("清空 latest/ 后必须把删除一并提交（cc-bridge 与 PastePanda 的有意差异）", () => {
    expect(addArgs()).toEqual(["add", "-A", "--", MANIFEST_DIR]);
  });

  it("URL 与凭据脱敏", () => {
    expect(giteeRawUrl("lzul/cc-bridge", MANIFEST_NAME)).toBe(
      "https://gitee.com/lzul/cc-bridge/raw/releases/latest/updater-gitee.json",
    );
    expect(githubGitUrl(DEFAULT_GH_REPO, "tok")).toBe(
      `https://x-access-token:tok@github.com/${DEFAULT_GH_REPO}.git`,
    );
    expect(sanitizeRemote("fatal: https://x-access-token:secret@github.com/x.git failed")).not.toContain("secret");
    expect(() => githubGitUrl(DEFAULT_GH_REPO, "")).toThrow(/两者/);
  });

  it("parseArgs：secret 未配时的空串要回落默认，不能拼出 gitee.com//raw", () => {
    const parsed = parseArgs([
      "--file", "dist-out/a.exe",
      "--file", `desktop/dist/${MANIFEST_NAME}`,
      "--gitee-repo", "",
    ]);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.giteeRepo).toBe(DEFAULT_GITEE_REPO);
    expect(parsed.ghRepo).toBe(DEFAULT_GH_REPO);
    expect(parsed.verify).toBe(true);
    expect(parsed.dryRun).toBe(false);
    expect(parseArgs(["--file", "x", "--dry-run", "--no-verify-readback"]).dryRun).toBe(true);
    expect(() => parseArgs(["--file"])).toThrow(/缺文件路径/);
  });

  it("verifyVerdict 四段逐段判，任一段不满足都不能算通过", () => {
    const base = {
      pushedSha: "abc", ghSha: "abc", giteeSha: "abc",
      version: "3.1.6", expectedVersion: "3.1.6", assets: { "a.exe": true },
    };
    expect(verifyVerdict(base)).toBe("ok");
    expect(verifyVerdict({ ...base, ghSha: "old" })).toBe("github");
    expect(verifyVerdict({ ...base, giteeSha: "old" })).toBe("mirror");
    expect(verifyVerdict({ ...base, version: "3.1.5" })).toBe("manifest");
    expect(verifyVerdict({ ...base, assets: { "a.exe": false } })).toBe("asset");
    expect(verifyVerdict({ ...base, assets: {} })).toBe("ok");
  });
});

/**
 * 端到端彩排：CI 的两道闸碰不到「clone → 清空 → 提交 → FF push」这条出境路径，
 * 而 --dry-run 在 clone 之前就 return。所以用一个本地 bare 仓真跑两遍：
 *   第一遍验证「分支不存在时能重建孤儿分支，且不会把 main 的源码跟进来」；
 *   第二遍验证「内容变了能 FF 推上去，且上一版残留的 exe 被清掉」。
 * 全程不联网、不碰真实远端（remote 参数就是为此留的）。
 */
describe("本地 bare 仓端到端彩排", () => {
  it("孤儿分支重建 + 第二次 FF 覆盖 + latest/ 整份替换", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "ccb-manifest-e2e-"));
    try {
      const bare = path.join(tmp, "remote.git");
      const seed = path.join(tmp, "seed");
      const src = path.join(tmp, "artifacts");
      git("init", "--bare", bare);
      git("init", seed);
      writeFileSync(path.join(seed, "README.md"), "seed\n");
      git("-C", seed, "add", "README.md");
      git("-C", seed, "-c", "user.email=test@local", "-c", "user.name=test", "commit", "-m", "seed");
      git("-C", seed, "push", bare, "HEAD:refs/heads/main");
      git("--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main");

      mkdirSync(src, { recursive: true });
      // 每次只写本次要发的文件；旧版文件留在 src 里不影响，因为 planFiles 只收传进来的那几个。
      const writeArtifacts = (version) => {
        writeFileSync(path.join(src, MANIFEST_NAME), JSON.stringify({ version }));
        writeFileSync(path.join(src, `cc-bridge_${version}_x64-setup.exe`), `exe ${version}`);
        return [path.join(src, MANIFEST_NAME), path.join(src, `cc-bridge_${version}_x64-setup.exe`)];
      };
      const firstFiles = writeArtifacts("3.1.6");

      const first = publishManifestBranch({ remote: bare, files: firstFiles, identity: { email: "ci@local", name: "ci" } });
      expect(first.pushed).toBe(true);
      expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
      const tree1 = git("--git-dir", bare, "ls-tree", "-r", "--name-only", MANIFEST_BRANCH);
      expect(tree1).toContain(`${MANIFEST_DIR}/${MANIFEST_NAME}`);
      expect(tree1).toContain("latest/cc-bridge_3.1.6_x64-setup.exe");
      expect(tree1, "孤儿分支把 main 的源码带进来了 —— reset --hard 不能删").not.toContain("README.md");

      // 第二遍：版本变了，分支已存在 ⇒ 走 clone --branch releases 的常规路径
      const secondFiles = writeArtifacts("3.1.7");
      const second = publishManifestBranch({ remote: bare, files: secondFiles, identity: { email: "ci@local", name: "ci" } });
      expect(second.pushed).toBe(true);
      expect(second.sha).not.toBe(first.sha);
      const tree2 = git("--git-dir", bare, "ls-tree", "-r", "--name-only", MANIFEST_BRANCH);
      expect(tree2).toContain("latest/cc-bridge_3.1.7_x64-setup.exe");
      expect(tree2, "latest/ 没清空，上一版 exe 还留在通道里").not.toContain("cc-bridge_3.1.6_x64-setup.exe");
      expect(JSON.parse(readFileSync(path.join(src, MANIFEST_NAME), "utf8")).version).toBe("3.1.7");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60000);
});
