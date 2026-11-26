import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { gitSubprocessEnv } from "./publish-manifest-branch.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));

it.each([false, true])("普通发版可提交，上一版是否启用强制更新：%s", (previouslyEnforced) => {
  const cwd = mkdtempSync(join(tmpdir(), "ccbridge release "));
  const env = gitSubprocessEnv();
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (file, value) => writeFileSync(join(cwd, file), value);
  try {
    for (const dir of ["desktop/scripts", "desktop/src-tauri", "desktop/src/lib"]) {
      mkdirSync(join(cwd, dir), { recursive: true });
    }
    for (const file of ["release.mjs", "check-release-notes.mjs", "sync-version.mjs", "gen-changelog.mjs"]) {
      copyFileSync(join(scripts, file), join(cwd, "desktop/scripts", file));
    }
    write("README.md", "# 版本历史\n\n| v3.4.0 | 当前版本 |\n");
    write("CHANGELOG.md", [
      "# 更新日志", "", "## [Unreleased]", "", "### 更新摘要", "",
      "这次更新让发布过程更加稳定可靠。", "", "### 修复", "",
      "- **普通更新可以正常发布**：同一份更新策略可以连续使用。", "",
      "## [3.4.0] - 2026-11-25", "",
    ].join("\n"));
    write("desktop/release-policy.json", `${JSON.stringify({ enforced: previouslyEnforced }, null, 2)}\n`);
    write("desktop/package.json", '{"version":"3.4.0"}\n');
    write("desktop/src-tauri/tauri.conf.json", '{"version":"3.4.0"}\n');
    write("desktop/src-tauri/Cargo.toml", '[package]\nversion = "3.4.0"\n');
    write("desktop/src-tauri/Cargo.lock", 'version = "3.4.0"\n');
    write("desktop/src/lib/changelog.generated.ts", "export const CHANGELOG = [];\n");
    git("init", "-q");
    git("config", "user.email", "release-test@example.invalid");
    git("config", "user.name", "CC Bridge release test");
    git("config", "core.hooksPath", ".git/hooks-disabled");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-qm", "test fixture");

    // 模拟 Cargo 门禁刷新锁文件。这里运行真实发版脚本，所有 Git 操作都在临时仓库。
    write("desktop/src-tauri/Cargo.lock", 'version = "3.4.1"\n');
    const result = spawnSync(process.execPath, ["desktop/scripts/release.mjs", "--patch", "--skip-tests"], {
      cwd, env, encoding: "utf8", stdio: "pipe",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(git("log", "-1", "--format=%s")).toBe("chg: 发版 v3.4.1");
    expect(JSON.parse(git("show", "HEAD:desktop/release-policy.json"))).toEqual({ enforced: false });
    expect(git("tag", "--list")).toBe("");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15000);

it.each(["--min", "--grace", "--message"])("强制发版缺少 %s 的参数值时报错", (flag) => {
  const result = spawnSync(
    process.execPath,
    [join(scripts, "release.mjs"), "--patch", "--force", flag, "--dry-run"],
    { encoding: "utf8", stdio: "pipe" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${flag} 缺少参数值`);
});
