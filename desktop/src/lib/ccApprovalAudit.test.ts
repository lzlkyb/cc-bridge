import { describe, expect, it } from "vitest";
import type { CcMessage } from "./ccGuiTypes";
import type { CcSessionBackup } from "./ccApprovalAudit";
import { approvalStat, buildApprovalAudit, pathKey, revertableFiles } from "./ccApprovalAudit";

const CWD = "/proj";

function user(id: string): CcMessage {
  return { kind: "user", id, text: "改一下", at: "" };
}

function toolMsg(
  id: string,
  name: string,
  input: Record<string, unknown>,
  result?: string,
): CcMessage {
  return {
    kind: "tool",
    id,
    at: "",
    tool: { id, name, input, status: result ? "ok" : "running", result },
  };
}

function approval(id: string, toolName: string, toolUseId: string | null, input = {}): CcMessage {
  return {
    kind: "approval",
    id,
    toolName,
    input,
    toolUseId,
    reason: "要改文件",
    expiresInSec: 60,
  };
}

function backup(tool: string, target: string, bak: string, ts = "2026-10-25T12:00:00+08:00"): CcSessionBackup {
  return { tool, targetPath: target, backupPath: bak, timestamp: ts };
}

describe("buildApprovalAudit", () => {
  it("审批点按 toolUseId 对上工具调用，不是按时间猜", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      approval("r1", "Edit", "t1"),
      toolMsg("t1", "Edit", { file_path: "/proj/src/a.ts", old_string: "a", new_string: "b" }),
    ];
    const groups = buildApprovalAudit(msgs, { r1: { decision: "allow" } }, [], CWD);
    expect(groups).toHaveLength(1);
    expect(groups[0].turn).toBe(1);
    // 已允许的审批不该和它的工具调用出两个点
    expect(groups[0].points).toHaveLength(1);
    expect(groups[0].points[0].decision).toBe("allow");
    expect(groups[0].points[0].files[0].path).toBe("/proj/src/a.ts");
  });

  it("被拒绝的调用留在列表里但没有文件", () => {
    const msgs: CcMessage[] = [user("u1"), approval("r1", "Edit", "t1")];
    const groups = buildApprovalAudit(msgs, { r1: { decision: "deny" } }, [], CWD);
    const p = groups[0].points[0];
    expect(p.decision).toBe("deny");
    expect(p.files).toEqual([]);
    expect(p.note).toContain("没有执行");
    expect(approvalStat(groups).denied).toBe(1);
  });

  it("历史会话没有审批事件时退化成 unknown，但改动照常列", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "Edit", { file_path: "/proj/src/a.ts", old_string: "a", new_string: "b" }),
    ];
    const groups = buildApprovalAudit(msgs, {}, [], CWD);
    expect(groups[0].points[0].decision).toBe("unknown");
    expect(groups[0].points[0].files).toHaveLength(1);
  });

  it("内置 Edit 走反向补丁，不需要备份", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "Edit", { file_path: "/proj/src/a.ts", old_string: "旧", new_string: "新" }),
    ];
    const f = buildApprovalAudit(msgs, {}, [], CWD)[0].points[0].files[0];
    expect(f.revert).toBe("patch");
    expect(f.patches).toEqual([{ oldString: "旧", newString: "新" }]);
  });

  it("MultiEdit 的每一处都进补丁，顺序与原入参一致", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "MultiEdit", {
        file_path: "/proj/src/a.ts",
        edits: [
          { old_string: "一", new_string: "1" },
          { old_string: "二", new_string: "2" },
        ],
      }),
    ];
    const f = buildApprovalAudit(msgs, {}, [], CWD)[0].points[0].files[0];
    expect(f.revert).toBe("patch");
    expect(f.patches).toEqual([
      { oldString: "一", newString: "1" },
      { oldString: "二", newString: "2" },
    ]);
  });

  it("内置 Write 新建的可删，覆盖的撤不了，判不出新建的也不猜", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      // 明说创建了 ⇒ 删掉它就是还原
      toolMsg(
        "t1",
        "Write",
        { file_path: "/proj/src/new.ts", content: "x" },
        "File created successfully at: /proj/src/new.ts",
      ),
      // 明说更新了 ⇒ 旧内容从没到过我们手上
      toolMsg(
        "t2",
        "Write",
        { file_path: "/proj/src/old.ts", content: "y" },
        "The file /proj/src/old.ts has been updated",
      ),
      // 同一个文件再写一次 ⇒ 无论文案如何都不是新建
      toolMsg(
        "t3",
        "Write",
        { file_path: "/proj/src/new.ts", content: "z" },
        "The file /proj/src/new.ts has been updated",
      ),
    ];
    const pts = buildApprovalAudit(msgs, {}, [], CWD)[0].points;
    expect(pts[0].files[0].revert).toBe("delete-created");
    expect(pts[0].files[0].created).toBe(true);
    expect(pts[1].files[0].revert).toBe("none");
    expect(pts[1].files[0].reason).toContain("旧内容");
    expect(pts[2].files[0].revert).toBe("none");
    expect(pts[2].files[0].created).toBe(false);
  });

  /// 🔴 判不出「新建」时必须说实话。判反了就是给用户一个「删掉你原有文件」的按钮。
  it("Write 结果文案认不出来时按「无法确认」处理，不给删除入口", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "Write", { file_path: "/proj/src/x.ts", content: "x" }, "ok"),
    ];
    const f = buildApprovalAudit(msgs, {}, [], CWD)[0].points[0].files[0];
    expect(f.revert).toBe("none");
    expect(f.created).toBe(false);
    expect(f.reason).toContain("确认不了");
  });

  it("相对路径按 cwd 补齐后匹配到审计里的绝对路径", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "write_files", { files: [{ path: "src/a.ts", content: "x" }] }),
    ];
    const groups = buildApprovalAudit(
      msgs,
      {},
      [backup("write_files", "/proj/src/a.ts", "/bak/1.bak")],
      CWD,
    );
    const f = groups[0].points[0].files[0];
    expect(f.revert).toBe("backup");
    expect(f.backupPath).toBe("/bak/1.bak");
  });

  it("同一份备份不会被两个改动点同时认领", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "write_files", { files: [{ path: "src/a.ts", content: "x" }] }),
      toolMsg("t2", "write_files", { files: [{ path: "src/a.ts", content: "y" }] }),
    ];
    const pools = [backup("write_files", "/proj/src/a.ts", "/bak/only.bak")];
    const pts = buildApprovalAudit(msgs, {}, pools, CWD)[0].points;
    expect(pts[0].files[0].revert).toBe("backup");
    expect(pts[1].files[0].revert).toBe("none");
    expect(pts[1].files[0].reason).toContain("没在审计里留下备份");
  });

  it("批量写多个文件时，只有认到备份的那个可还原，其余如实标注", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "write_files", {
        files: [
          { path: "src/a.ts", content: "x" },
          { path: "src/b.ts", content: "y" },
        ],
      }),
    ];
    const groups = buildApprovalAudit(
      msgs,
      {},
      // 审计只有一个槽位：批量写的最后一个
      [backup("write_files", "/proj/src/b.ts", "/bak/b.bak")],
      CWD,
    );
    const files = groups[0].points[0].files;
    expect(files).toHaveLength(2);
    expect(files[0].revert).toBe("none");
    expect(files[1].revert).toBe("backup");
  });

  it("按用户消息切轮次，空轮不产出组", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "Edit", { file_path: "/proj/a.ts", old_string: "a", new_string: "b" }),
      user("u2"),
      user("u3"),
      toolMsg("t2", "Edit", { file_path: "/proj/b.ts", old_string: "a", new_string: "b" }),
    ];
    const groups = buildApprovalAudit(msgs, {}, [], CWD);
    expect(groups.map((g) => g.turn)).toEqual([1, 3]);
  });

  it("非改文件的调用不进列表（Bash / Read 不猜）", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "Bash", { command: "sed -i s/a/b/ x" }),
      toolMsg("t2", "Read", { file_path: "/proj/a.ts" }),
    ];
    expect(buildApprovalAudit(msgs, {}, [], CWD)).toEqual([]);
  });

  it("汇总数的是文件，不是点", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "write_files", {
        files: [
          { path: "src/a.ts", content: "x" },
          { path: "src/b.ts", content: "y" },
        ],
      }),
    ];
    const groups = buildApprovalAudit(msgs, {}, [backup("write_files", "/proj/src/a.ts", "/bak/a")], CWD);
    expect(approvalStat(groups)).toEqual({ points: 1, files: 2, revertable: 1, denied: 0 });
    expect(revertableFiles(groups[0].points[0])).toHaveLength(1);
  });

  /* ── 展示内容（优化轨道 A）：能不能撤销 ≠ 能不能看 ────────────────── */

  it("撤不了的编辑仍然带着原文，面板照样能展开看", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "Edit", { file_path: "/proj/a.ts", old_string: "", new_string: "只有新内容" }),
    ];
    const f = buildApprovalAudit(msgs, {}, [], CWD)[0].points[0].files[0];
    expect(f.revert).toBe("none");
    expect(f.reason).toContain("没有可反向恢复的原文");
    // 撤销没有回头路，但「改了什么」照样给出
    expect(f.patches).toEqual([{ oldString: "", newString: "只有新内容" }]);
  });

  it("批量写的每个文件都带上自己那份内容，按入参顺序对齐", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "write_files", {
        files: [
          { path: "src/a.ts", content: "AAA" },
          { path: "src/b.ts", content: "BBB" },
        ],
      }),
    ];
    const files = buildApprovalAudit(msgs, {}, [], CWD)[0].points[0].files;
    expect(files[0].writtenContent).toBe("AAA");
    expect(files[1].writtenContent).toBe("BBB");
  });

  it("base64 写入不带文本内容：二进制按文本展示只会是乱码", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg("t1", "write_files", {
        files: [{ path: "src/logo.png", content: "iVBORw0KGgo=", encoding: "base64" }],
      }),
    ];
    const f = buildApprovalAudit(msgs, {}, [], CWD)[0].points[0].files[0];
    expect(f.writtenContent).toBeUndefined();
  });

  it("Write 覆盖已有文件也带着写入内容（只是没有旧内容可对比）", () => {
    const msgs: CcMessage[] = [
      user("u1"),
      toolMsg(
        "t1",
        "Write",
        { file_path: "/proj/a.ts", content: "新内容" },
        "The file /proj/a.ts has been updated",
      ),
    ];
    const f = buildApprovalAudit(msgs, {}, [], CWD)[0].points[0].files[0];
    expect(f.revert).toBe("none");
    expect(f.writtenContent).toBe("新内容");
  });
});

describe("pathKey", () => {
  it("相对路径按 cwd 补齐，分隔符与盘符大小写归一", () => {
    expect(pathKey("src\\a.ts", "/proj")).toBe("/proj/src/a.ts");
    expect(pathKey("C:\\Src\\A.ts", null)).toBe("c:/src/a.ts");
    // POSIX 大小写敏感：不动
    expect(pathKey("/Proj/A.ts", null)).toBe("/Proj/A.ts");
  });

  it("没有 cwd 时相对路径只做归一（开头的 ./ 会去掉）", () => {
    expect(pathKey("./src/a.ts", null)).toBe("src/a.ts");
  });
});
