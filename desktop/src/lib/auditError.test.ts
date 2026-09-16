import { describe, it, expect } from "vitest";
import { friendlyAuditError } from "./auditError";

/**
 * 这些断言锁的是两件容易静默坏掉的事：
 * ① 匹配顺序（`os error 5` 必须先于 `os error 2` 判定，否则权限错误会被
 *    当成文件缺失，用户按提示去查路径，白折腾）；
 * ② 原始串必须始终保留——排查全指望它。
 */
describe("friendlyAuditError", () => {
  it("备份文件不存在", () => {
    const r = friendlyAuditError("backup not found: /a/b.json");
    expect(r).toContain("备份文件不存在或已被清理");
    expect(r).toContain("backup not found: /a/b.json");
  });

  it("中文「不存在」也能命中（后端自带中文文案时）", () => {
    expect(friendlyAuditError("备份 不存在")).toContain("备份文件不存在或已被清理");
  });

  it("文件被占用（os error 32 / being used）", () => {
    expect(friendlyAuditError("The process cannot access the file (os error 32)")).toContain(
      "正被其它程序占用",
    );
    expect(friendlyAuditError("Resource busy")).toContain("正被其它程序占用");
    expect(friendlyAuditError("file is being used by another process")).toContain(
      "正被其它程序占用",
    );
  });

  it("权限不足（os error 5 / permission denied 都要命中）", () => {
    // 🔴 顺序敏感：`os error 5` 若排在 `os error 2` 之后，这里会因为 5 内含
    // 不了 2 而侥幸不错；但若有人把 2 提前，权限错误就会被误判成文件缺失。
    expect(friendlyAuditError("Access is denied. (os error 5)")).toContain("没有读写权限");
    expect(friendlyAuditError("Permission denied")).toContain("没有读写权限");
    expect(friendlyAuditError("EACCES: denied")).toContain("没有读写权限");
  });

  it("文件/目录不存在（os error 2）", () => {
    expect(friendlyAuditError("The system cannot find the file specified. (os error 2)")).toContain(
      "文件或目录不存在",
    );
  });

  it("os error 2 不能被「权限」分支截胡", () => {
    const r = friendlyAuditError("No such file or directory (os error 2)");
    expect(r).toContain("文件或目录不存在");
    expect(r).not.toContain("没有读写权限");
  });

  it("未知错误保留原始串，不吞", () => {
    const r = friendlyAuditError("some unexpected failure");
    expect(r).toContain("操作失败");
    expect(r).toContain("some unexpected failure");
  });

  it("非字符串入参不抛（Error 用 message，对象走 String()）", () => {
    expect(friendlyAuditError(new Error("boom"))).toContain("boom");
    expect(() => friendlyAuditError(undefined)).not.toThrow();
    expect(() => friendlyAuditError({ code: 1 })).not.toThrow();
    expect(friendlyAuditError(undefined)).toContain("undefined");
  });
});
