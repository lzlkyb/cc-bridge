import { describe, expect, it } from "vitest";
import { changesetStat, collectChangeset, shortPath } from "./ccChangeset";
import type { CcMessage, CcToolStatus } from "./ccGuiTypes";

/**
 * 锁聚合口径。这个列表是用户「回看这一轮改了什么」的唯一依据：漏一个文件
 * （比如 NotebookEdit 的 notebook_path）或者把失败那次算成成功，都会让人
 * 以为改动落地了——而它没有。
 */
function tool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  status: CcToolStatus = "ok",
): CcMessage {
  return { kind: "tool", id, at: "", tool: { id, name, input, status } };
}

describe("collectChangeset", () => {
  it("Edit/Write 按路径聚合，同文件多次计多次", () => {
    const v = collectChangeset([
      tool("t1", "Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" }),
      tool("t2", "Write", { file_path: "/a/b.ts", content: "whole" }),
      tool("t3", "Edit", { file_path: "/a/c.ts", old_string: "x", new_string: "y" }),
    ]);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ path: "/a/b.ts", edits: 2, failed: 0, created: false, messageId: "t1" });
    expect(v[1]).toMatchObject({ path: "/a/c.ts", edits: 1, messageId: "t3" });
  });

  it("MultiEdit / NotebookEdit 也算，路径键各自不同", () => {
    const v = collectChangeset([
      tool("t1", "MultiEdit", { file_path: "/a/m.ts", edits: [] }),
      tool("t2", "NotebookEdit", { notebook_path: "/a/n.ipynb", new_source: "1" }),
      tool("t3", "Edit", { path: "/a/p.ts", old_string: "a", new_string: "b" }),
    ]);
    expect(v.map((e) => e.path)).toEqual(["/a/m.ts", "/a/n.ipynb", "/a/p.ts"]);
  });

  it("Read/Bash 等非落盘工具不计；读不到路径的丢弃", () => {
    const v = collectChangeset([
      tool("t1", "Read", { file_path: "/a/read.ts" }),
      tool("t2", "Bash", { command: "sed -i s/a/b/ /a/x.ts" }),
      tool("t3", "Edit", { old_string: "x", new_string: "y" }),
      { kind: "user", id: "u1", at: "", text: "hi" },
    ]);
    expect(v).toEqual([]);
  });

  it("失败次数单独计，created 看第一次是不是 Write", () => {
    const v = collectChangeset([
      tool("t1", "Write", { file_path: "/a/new.ts", content: "x" }, "error"),
      tool("t2", "Write", { file_path: "/a/new.ts", content: "x" }),
      tool("t3", "Edit", { file_path: "/a/old.ts", old_string: "a", new_string: "b" }, "error"),
    ]);
    expect(v[0]).toMatchObject({ created: true, edits: 2, failed: 1 });
    expect(v[1]).toMatchObject({ created: false, edits: 1, failed: 1 });
  });

  it("isError 兜底：result 标了错但 status 还是 ok 的也算失败", () => {
    const v = collectChangeset([
      { kind: "tool", id: "t1", at: "", tool: { id: "t1", name: "Edit", input: { file_path: "/a.ts" }, status: "ok", isError: true } },
    ]);
    expect(v[0].failed).toBe(1);
  });

  it("顺序按首次出现，不按字典序", () => {
    const v = collectChangeset([
      tool("t1", "Edit", { file_path: "/z.ts" }),
      tool("t2", "Edit", { file_path: "/a.ts" }),
    ]);
    expect(v.map((e) => e.path)).toEqual(["/z.ts", "/a.ts"]);
  });
});

describe("changesetStat", () => {
  it("空列表三项全 0", () => {
    expect(changesetStat([])).toEqual({ files: 0, edits: 0, failed: 0 });
  });

  it("汇总各文件次数", () => {
    const v = collectChangeset([
      tool("t1", "Edit", { file_path: "/a.ts" }),
      tool("t2", "Edit", { file_path: "/a.ts" }),
      tool("t3", "Edit", { file_path: "/b.ts" }, "error"),
    ]);
    expect(changesetStat(v)).toEqual({ files: 2, edits: 3, failed: 1 });
  });
});

describe("shortPath", () => {
  it("取后两段，兼容反斜杠", () => {
    expect(shortPath("/a/b/c.ts")).toBe("b/c.ts");
    expect(shortPath("C:\\x\\y\\z.rs")).toBe("y/z.rs");
    expect(shortPath("solo.ts")).toBe("solo.ts");
  });
});
