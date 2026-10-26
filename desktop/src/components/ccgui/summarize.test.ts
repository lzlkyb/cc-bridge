import { describe, expect, it } from "vitest";
import type { CcMessage } from "../../lib/ccGuiTypes";
import {
  TOOL_TEXT_LIMIT,
  approvalCopyText,
  approvalPayload,
  buildConvHits,
  clampToolText,
  convSegments,
  editCount,
  editPair,
  thinkingTitle,
  todoItems,
  toolDefaultOpen,
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

describe("toolDefaultOpen 详略三档", () => {
  it("标准档 = 改动前的行为（Edit/Write 展开、Bash 看有没有输出、其余收起）", () => {
    expect(toolDefaultOpen("n", "edit", true, false)).toBe(true);
    expect(toolDefaultOpen("n", "write", true, false)).toBe(true);
    expect(toolDefaultOpen("n", "bash", true, true)).toBe(true);
    expect(toolDefaultOpen("n", "bash", false, false)).toBe(false);
    expect(toolDefaultOpen("n", "read", true, false)).toBe(false);
    expect(toolDefaultOpen("n", "other", true, false)).toBe(false);
  });

  it("精简档一律收起 —— 一次重构三十次 Edit 也不摊开", () => {
    for (const kind of ["edit", "write", "bash", "read", "other"] as const) {
      expect(toolDefaultOpen("c", kind, true, true)).toBe(false);
    }
  });

  it("详细档有内容就摊开（Read 与 MCP 工具的入参 JSON 只在这一档露出来）", () => {
    expect(toolDefaultOpen("v", "read", true, false)).toBe(true);
    expect(toolDefaultOpen("v", "other", true, false)).toBe(true);
    expect(toolDefaultOpen("v", "edit", true, false)).toBe(true);
    // 没有内容可展开的工具（例如纯文本工具）摊不开，别给它一个空壳
    expect(toolDefaultOpen("v", "other", false, false)).toBe(false);
  });
});

describe("approvalPayload 审批卡看什么", () => {
  /// 这条是审批面最核心的判据：Edit 必须给 diff。曾经一律 JSON.stringify，
  /// 用户在 `"old_string": "const a = 1;\nconst b = 2;"` 里判断要不要放行文件改动 ——
  /// 字面的 `\n` 人读不出来，等于盲批。
  it("Edit → diff（旧/新都拿到，不是转义 JSON）", () => {
    const p = approvalPayload("Edit", {
      file_path: "/repo/src/a.ts",
      old_string: "const a = 1;\nconst b = 2;",
      new_string: "const a = 1;\nconst b = 3;",
    });
    expect(p.kind).toBe("diff");
    if (p.kind !== "diff") return;
    expect(p.oldText).toBe("const a = 1;\nconst b = 2;");
    expect(p.newText).toBe("const a = 1;\nconst b = 3;");
    expect(p.path).toBe("/repo/src/a.ts");
    expect(p.edits).toBe(1);
    // 单处修改不啰嗦
    expect(p.note).toBe("");
  });

  it("MultiEdit → diff 且说清「共 N 处」（多处按顺序拼接）", () => {
    const p = approvalPayload("MultiEdit", {
      file_path: "/repo/b.ts",
      edits: [
        { old_string: "一", new_string: "1" },
        { old_string: "二", new_string: "2" },
      ],
    });
    expect(p.kind).toBe("diff");
    if (p.kind !== "diff") return;
    expect(p.edits).toBe(2);
    expect(p.newText).toBe("1\n⋯\n2");
    expect(p.note).toContain("共 2 处");
  });

  it("Write → 全 + 的 diff，并如实说明「看不到改动前的样子」", () => {
    const p = approvalPayload("Write", { file_path: "/repo/new.ts", content: "export const x = 1;\n" });
    expect(p.kind).toBe("diff");
    if (p.kind !== "diff") return;
    expect(p.oldText).toBe("");
    expect(p.newText).toBe("export const x = 1;\n");
    expect(p.note).toContain("改动前的样子");
  });

  /// `content` 是空串也要走 diff：用真假判会把它当成「没有内容」退化成一团 JSON，
  /// 而「写一个空文件」本身是个要紧的决定，得让人看见「它将变空」。
  it("Write 空内容 → 仍是 diff（空串不等于没有字段）", () => {
    const p = approvalPayload("Write", { file_path: "/repo/empty.ts", content: "" });
    expect(p.kind).toBe("diff");
    if (p.kind !== "diff") return;
    expect(p.newText).toBe("");
  });

  it("Bash → 命令原文", () => {
    const p = approvalPayload("Bash", { command: "rm -rf dist", description: "清掉构建产物" });
    expect(p).toEqual({ kind: "command", text: "rm -rf dist" });
  });

  it("认不出的工具（桥的 write_files / MCP）→ JSON 兜底", () => {
    const input = { files: [{ path: "/a", content: "x" }] };
    const p = approvalPayload("mcp__cc-bridge__write_files", input);
    expect(p.kind).toBe("json");
    if (p.kind !== "json") return;
    expect(p.text).toBe(JSON.stringify(input, null, 2));
  });

  it("Edit 形状不认识（没 old/new）→ 退 JSON 而不是画个空 diff", () => {
    const p = approvalPayload("Edit", { file_path: "/a.ts", mystery: 1 });
    expect(p.kind).toBe("json");
  });

  /// 剪贴板里放无损原文：拼出来的 `- 旧 / + 新` 粘到别处还原不回去。
  it("approvalCopyText 是完整入参原文", () => {
    const input = { file_path: "/a.ts", old_string: "a", new_string: "b" };
    expect(JSON.parse(approvalCopyText(input))).toEqual(input);
  });
});
