import { describe, expect, it } from "vitest";
import { conversationMarkdown, type ExportMeta } from "./ccExport";
import type { CcMessage } from "./ccGuiTypes";

const META: ExportMeta = { title: "修一下登录", cwd: "/repo", model: "opus", at: "2026-10-26 21:00" };

const user = (text: string, images?: string[]): CcMessage => ({ kind: "user", id: `u`, at: "", text, images });
const ai = (text: string): CcMessage => ({ kind: "assistant", id: "a", at: "", text });

describe("conversationMarkdown", () => {
  it("标题 + 元信息 + 角色分段", () => {
    const md = conversationMarkdown([user("帮我看看"), ai("好的")], META);
    expect(md.startsWith("# 修一下登录")).toBe(true);
    expect(md).toContain("- 目录：`/repo`");
    expect(md).toContain("- 模型：opus");
    expect(md).toContain("## 我\n\n帮我看看");
    expect(md).toContain("## CC\n\n好的");
  });

  /// 标题为空时不能输出 `# ` 这种半截标题 —— 那在 Markdown 里是空的一级标题。
  it("空标题退化成「对话」", () => {
    expect(conversationMarkdown([user("x")], { ...META, title: "   " })).toContain("# 对话");
  });

  it("思考链折进 details，不混进正文", () => {
    const md = conversationMarkdown([{ kind: "thinking", id: "h", at: "", text: "先读代码" }], META);
    expect(md).toContain("<details><summary>思考过程</summary>");
    expect(md).toContain("先读代码");
    expect(md).not.toContain("## CC");
  });

  /// 🔴 这是本模块最容易写错的一处：工具输出里出现三反引号是常事（`cat README.md`），
  /// 固定用 ``` 包会让代码块提前闭合，后面整段变成散落的普通文字。
  it("工具输出里的反引号不会提前闭合代码块", () => {
    const md = conversationMarkdown(
      [
        {
          kind: "tool",
          id: "t",
          at: "",
          tool: { id: "tu", name: "Bash", input: { command: "cat a.md" }, status: "ok", result: "前\n```js\nx\n```\n后" },
        },
      ],
      META,
    );
    // 围栏至少四层，才能把内容里的三层安全包住
    expect(md).toContain("````\n前\n```js\nx\n```\n后\n````");
  });

  /// diff 是过程不是结论：一次重构三十次 Edit，全导出来是几 MB 补丁，反而没人看。
  it("Edit / Write 只记文件与处数，不导 diff", () => {
    const md = conversationMarkdown(
      [
        {
          kind: "tool",
          id: "t1",
          at: "",
          tool: {
            id: "tu1",
            name: "Edit",
            input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
            status: "ok",
          },
        },
        {
          kind: "tool",
          id: "t2",
          at: "",
          tool: { id: "tu2", name: "Write", input: { file_path: "/repo/b.ts", content: "新内容" }, status: "ok" },
        },
      ],
      META,
    );
    expect(md).toContain("`Edit` repo/a.ts");
    expect(md).toContain("（1 处修改，diff 见会话记录）");
    expect(md).toContain("`Write` repo/b.ts");
    expect(md).toContain("（整体写入，diff 见会话记录）");
    expect(md).not.toContain("新内容");
  });

  /// Read 的 body 是入参 JSON（`{"file_path": "/..."}`），对读的人没有信息量。
  it("Read 只留标题，不带入参 JSON", () => {
    const md = conversationMarkdown(
      [
        {
          kind: "tool",
          id: "t",
          at: "",
          tool: { id: "tu", name: "Read", input: { file_path: "/repo/a.ts" }, status: "ok" },
        },
      ],
      META,
    );
    expect(md).toContain("`Read` repo/a.ts");
    expect(md).not.toContain("file_path");
  });

  /// 审批卡是一次交互的凭据，不是对话内容；混进来只会让导出读起来像日志。
  it("审批 / 提问卡不进导出", () => {
    const md = conversationMarkdown(
      [
        { kind: "approval", id: "r1", toolName: "Bash", input: { command: "ls" }, reason: "要跑命令", expiresInSec: 60 },
        ai("继续"),
      ],
      META,
    );
    expect(md).not.toContain("要跑命令");
    expect(md).not.toContain("Bash");
    expect(md).toContain("继续");
  });

  /// 图只有缩略图、原图不落盘，导出里放不进去 —— 但必须说明这条带过图，
  /// 否则读的人会以为上面那段话就是全部。
  it("带图的消息标注张数", () => {
    const md = conversationMarkdown([user("看图", ["data:1", "data:2"])], META);
    expect(md).toContain("（附 2 张图，原图未保留）");
  });

  it("连续空行压到两条，结尾只有一个换行", () => {
    const md = conversationMarkdown([user("a"), ai("b")], META);
    expect(md).not.toMatch(/\n{3,}/);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});
