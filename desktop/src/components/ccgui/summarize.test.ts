import { describe, expect, it } from "vitest";
import type { CcMessage } from "../../lib/ccGuiTypes";
import {
  TOOL_TEXT_LIMIT,
  buildConvHits,
  clampToolText,
  convSegments,
  editCount,
  editPair,
  thinkingTitle,
  todoItems,
  toolKind,
} from "./summarize";

describe("summarize", () => {
  it("editPair：单处 Edit 走 old_string/new_string", () => {
    expect(editPair({ old_string: "a", new_string: "b" })).toEqual({ oldText: "a", newText: "b" });
  });

  /// MultiEdit 的多处修改必须**全部**进 diff —— 只取第一处是老缺陷：
  /// 改 10 处只看到第 1 处，± 统计也只数了第 1 处。
  it("editPair：MultiEdit 按顺序拼接全部 edits，不丢第 2 处起的内容", () => {
    const pair = editPair({
      edits: [
        { old_string: "一", new_string: "1" },
        { old_string: "二", new_string: "2" },
      ],
    });
    expect(pair).not.toBeNull();
    expect(pair!.oldText).toBe("一\n⋯\n二");
    expect(pair!.newText).toBe("1\n⋯\n2");
    // ⋯ 分隔行两侧一致，diff 里落成上下文行，正好当视觉分界。
    expect(pair!.oldText.split("\n")[1]).toBe("⋯");
    expect(pair!.newText.split("\n")[1]).toBe("⋯");
  });

  it("editPair：没有可识别形状时返回 null", () => {
    expect(editPair({})).toBeNull();
    expect(editPair({ edits: [] })).toBeNull();
  });

  it("editCount：MultiEdit 数组长度，其余恒为 1", () => {
    expect(editCount({ edits: [{}, {}, {}] })).toBe(3);
    expect(editCount({ edits: [] })).toBe(1);
    expect(editCount({ old_string: "a", new_string: "b" })).toBe(1);
  });

  it("clampToolText：上限内原样、超限截断并标记", () => {
    const short = "x".repeat(10);
    expect(clampToolText(short)).toEqual({ text: short, clipped: false });
    const long = "x".repeat(TOOL_TEXT_LIMIT + 5);
    const cl = clampToolText(long);
    expect(cl.clipped).toBe(true);
    expect(cl.text.length).toBe(TOOL_TEXT_LIMIT);
  });

  it("toolKind：TodoWrite 归 todo；MCP 名取尾段查表、不子串误伤", () => {
    expect(toolKind("TodoWrite")).toBe("todo");
    expect(toolKind("Edit")).toBe("edit");
    expect(toolKind("mcp__x__TodoWrite")).toBe("todo");
    expect(toolKind("TodoListSomething")).toBe("other");
  });

  it("todoItems：全量列表原样解析，status 越界回落 pending", () => {
    expect(
      todoItems({
        todos: [
          { content: "第一步", status: "completed" },
          { content: "第二步", status: "in_progress" },
          { content: "第三步", status: "pending" },
          { content: "第四步", status: "weird" },
        ],
      }),
    ).toEqual([
      { content: "第一步", status: "completed" },
      { content: "第二步", status: "in_progress" },
      { content: "第三步", status: "pending" },
      { content: "第四步", status: "pending" },
    ]);
  });

  it("todoItems：形状不对返回 null（空 content 跳过，全空即 null）", () => {
    expect(todoItems({})).toBeNull();
    expect(todoItems({ todos: [] })).toBeNull();
    expect(todoItems({ todos: [{ status: "pending" }, { content: "", status: "pending" }] })).toBeNull();
  });

  it("thinkingTitle：首个非空行 + 60 字截断，与 ThinkingBlock 口径一致", () => {
    expect(thinkingTitle("\n\n  \n第二行才是标题")).toBe("第二行才是标题");
    expect(thinkingTitle("x".repeat(61))).toBe(`${"x".repeat(60)}…`);
    expect(thinkingTitle("x".repeat(60))).toBe("x".repeat(60));
    expect(thinkingTitle("   ")).toBe("（空）");
  });

  /// 搜索段的取法必须与渲染层逐字一致 —— 这组用例锁「段 = 叶子」的口径。
  it("convSegments：markdown 正文按叶子切段（语法符号不入段）", () => {
    const m: CcMessage = {
      kind: "assistant",
      id: "a1",
      at: "",
      text: "先说结论\n\n- **甲**项\n- 乙项\n\n```bash\ntar -x\n```\n",
    };
    // 强调内部与紧跟其后的文字是两个叶子（strong.tokens 与兄弟 text token）
    expect(convSegments(m)).toEqual(["先说结论", "甲", "项", "乙项", "tar -x"]);
  });

  it("convSegments：工具行只取参数摘要；思考只取标题", () => {
    const tool: CcMessage = {
      kind: "tool",
      id: "t1",
      at: "",
      tool: { id: "tu1", name: "Edit", input: { file_path: "/repo/src/a.ts" }, status: "ok" },
    };
    expect(convSegments(tool)).toEqual(["src/a.ts"]);
    const think: CcMessage = { kind: "thinking", id: "h1", at: "", text: "标题行\n后面很长的思考" };
    expect(convSegments(think)).toEqual(["标题行"]);
  });

  it("buildConvHits：按文档顺序收集、跨段定位、大小写不敏感", () => {
    const messages: CcMessage[] = [
      { kind: "user", id: "u1", at: "", text: "改一下 Transfer.rs" },
      { kind: "assistant", id: "a1", at: "", text: "好的，先读 `transfer.rs` 再改 Transfer 逻辑" },
    ];
    const hits = buildConvHits(messages, "transfer");
    // u1 一处（正文叶子）；a1 两处（行内代码叶子 + 尾段正文叶子）
    expect(hits.map((h) => `${h.msgId}:${h.seg}`)).toEqual(["u1:0", "a1:1", "a1:2"]);
    // 区间自证：按所在段切片，小写后应恰好是查询串（不手算下标，防两边一起错）
    for (const h of hits) {
      const seg = convSegments(messages.find((m) => m.id === h.msgId)!)[h.seg];
      expect(seg.slice(h.start, h.end).toLowerCase()).toBe("transfer");
    }
  });

  it("buildConvHits：空查询无命中", () => {
    expect(buildConvHits([{ kind: "user", id: "u1", at: "", text: "任意" }], "  ")).toEqual([]);
  });
});
