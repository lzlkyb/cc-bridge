import { describe, expect, it } from "vitest";
import type { Root } from "hast";
import { highlightCode } from "./ccCodeHighlight";

/** 把 hast 树里的全部文本拼回去 —— 高亮**不能改动任何一个字符**。 */
function textOf(node: Root | Root["children"][number]): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" || node.type === "root") return node.children.map(textOf).join("");
  return "";
}

function classes(tree: Root): string[] {
  const out: string[] = [];
  const walk = (nodes: Root["children"]) => {
    for (const n of nodes) {
      if (n.type !== "element") continue;
      const cls = n.properties?.className;
      if (Array.isArray(cls)) out.push(...cls.map(String));
      walk(n.children);
    }
  };
  walk(tree.children);
  return out;
}

describe("highlightCode", () => {
  it("已知语言产出带 hljs 类的树，且文本与原代码逐字相同", () => {
    const code = "const answer: number = 42; // 注释";
    const tree = highlightCode(code, "typescript");
    expect(tree).not.toBeNull();
    expect(textOf(tree!) + "\n").toBe(`${code}\n`);
    expect(classes(tree!).some((c) => c.startsWith("hljs-"))).toBe(true);
  });

  /// 🔴 高亮是纯装饰：任何一个字符被吞掉或改写，用户就会复制到错的代码。
  it("多行代码逐字保留（含缩进、空行、中文）", () => {
    const code = "fn main() {\n\n    println!(\"你好\");\n}";
    const tree = highlightCode(code, "rust");
    expect(textOf(tree!) + "\n").toBe(`${code}\n`);
  });

  it("别名与大小写都能命中（TS/tsx/sh/yml/html）", () => {
    for (const lang of ["TS", "tsx", "sh", "yml", "html", "md"]) {
      expect(highlightCode("let a = 1", lang), lang).not.toBeNull();
    }
  });

  it("未知语言返回 null（调用方退回纯文本，不是报错）", () => {
    expect(highlightCode("whatever", "brainfuck")).toBeNull();
    expect(highlightCode("whatever", "")).toBeNull();
  });

  it("空代码返回 null（不产生空树）", () => {
    expect(highlightCode("", "typescript")).toBeNull();
  });
});
