import { describe, expect, it } from "vitest";
import { TOOL_TEXT_LIMIT, clampToolText, editCount, editPair } from "./summarize";

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
});
