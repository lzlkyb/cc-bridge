import { describe, expect, it } from "vitest";
import { markdownLeaves } from "./ccMarkdown";

/**
 * 锁两件事：
 * 1. 叶子抽取 = 渲染时可见文本（fenced 块、表格、行内代码都是可见文本，都要抽到）
 * 2. 顺序稳定 —— 会话内搜索的命中区间靠「seg 序号」落到渲染叶子上，
 *    `walkTextLeaves` 与 `MarkdownText` 的渲染递归同构是整条链路的前提。
 *    这里的用例形状挑的是遍历容易走岔的：嵌套列表、表格、引用套代码、行内代码。
 */
describe("markdownLeaves", () => {
  it("段落与行内格式：语法符号不属于可见文本", () => {
    const leaves = markdownLeaves("好的，**重点**与 `code`、[链接](https://a.b) 结束");
    expect(leaves.join("")).toBe("好的，重点与 code、链接 结束");
  });

  it("fenced 代码块整体是一个叶子", () => {
    const md = "前文\n\n```bash\ntar -x\n  --flag\n```\n\n后文";
    const leaves = markdownLeaves(md);
    expect(leaves).toEqual(["前文", "tar -x\n  --flag", "后文"]);
  });

  it("单换行（breaks:true）拆成两个叶子，<br> 本身没有叶子", () => {
    const leaves = markdownLeaves("第一行\n第二行");
    expect(leaves).toEqual(["第一行", "第二行"]);
  });

  it("列表（含嵌套）按阅读顺序抽取", () => {
    const md = "- 甲\n- 乙\n  - 乙一\n- 丙";
    const leaves = markdownLeaves(md);
    expect(leaves.join("|")).toBe("甲|乙|乙一|丙");
  });

  it("表格按行序（表头 → 各行）抽取", () => {
    const md = "| h1 | h2 |\n|---|---|\n| a | b |\n| c | d |";
    const leaves = markdownLeaves(md);
    expect(leaves.join("|")).toBe("h1|h2|a|b|c|d");
  });

  it("引用块递归到内部段落", () => {
    const leaves = markdownLeaves("> 引用里的话");
    expect(leaves).toEqual(["引用里的话"]);
  });

  it("标题是叶子", () => {
    const leaves = markdownLeaves("### 小节标题");
    expect(leaves).toEqual(["小节标题"]);
  });
});
