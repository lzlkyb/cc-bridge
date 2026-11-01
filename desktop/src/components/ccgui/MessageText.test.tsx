// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MessageText } from "./MessageText";
import { ToastProvider } from "../ui/toast";

/**
 * Markdown 渲染的结构性契约（行为正确性在 `ccMarkdown.test.ts`，这里验「渲染出来了」）：
 * - 代码块：语言角标 + 复制按钮 + 内容可见
 * - 链接白名单：javascript: 不成链接，https: 才有 target=_blank
 * - 原始 HTML 不解析：以文本形态出现，DOM 里没有对应元素
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(text: string) {
  act(() => {
    root.render(
      <ToastProvider>
        <MessageText text={text} />
      </ToastProvider>,
    );
  });
}

it("fenced 代码块渲染为带语言角标与复制按钮的等宽块", () => {
  render('说明\n\n```bash\ntar -xzf out.tar.gz\n```');
  expect(container.querySelector("pre")?.textContent).toContain("tar -xzf out.tar.gz");
  expect(container.textContent).toContain("bash");
  expect(container.querySelector('button[aria-label="复制代码"]')).toBeTruthy();
});

it("列表与粗体渲染成元素而不是源码", () => {
  render("1. **加粗** 项");
  expect(container.querySelector("ol")).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("加粗");
  expect(container.textContent).not.toContain("**");
});

/**
 * 🔴 紧凑列表的 `<li>` 里**不能有块级 `<p>`**。
 *
 * 列表是 `list-inside`，项目符号属于行内盒。`li` 的第一个子元素一旦是块级的
 * `<p>`，marker 会自成一行、正文整体下移 —— 表现就是截图里孤零零一个 `•`
 * 挂在上一行、内容和它分家。这条断言直接盯着那个结构。
 */
it("紧凑列表：项目符号与内容同行（li 内不出现 p）", () => {
  render("- `Path`: /tmp/ws\n- `Contents`: 空目录\n");
  const lis = Array.from(container.querySelectorAll("li"));
  expect(lis).toHaveLength(2);
  for (const li of lis) {
    expect(li.querySelector("p")).toBeNull();
    expect(li.textContent).toContain(":");
  }
});

it("松列表（项之间有空行）仍按段落分段", () => {
  render("- 第一项\n\n- 第二项\n");
  const lis = Array.from(container.querySelectorAll("li"));
  expect(lis).toHaveLength(2);
  expect(lis[0].querySelector("p")).not.toBeNull();
});

it("https 链接带 target=_blank；javascript: 不成链接", () => {
  render("[正常](https://example.com) 与 [危险](javascript:alert(1))");
  const links = Array.from(container.querySelectorAll("a"));
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("href")).toBe("https://example.com/");
  expect(links[0].getAttribute("target")).toBe("_blank");
  expect(container.textContent).toContain("危险");
});

it("原始 HTML 不解析：script 以文本形态出现，不产生元素", () => {
  render('正文 <script>alert(1)</script> 结束');
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("alert(1)");
});

/**
 * 🔴 GFM 任务列表：`- [ ]` / `- [x]` 的勾选状态以前被完全吞掉
 * （`checkbox` token 落进 `default` 分支读不存在的 `text`），已完成项与未完成项
 * 在界面上长得一模一样。这两条钉住两种列表形态（紧凑 / 松）都要保留勾选。
 */
it("任务列表：紧凑形态保留勾选状态", () => {
  render("- [ ] 未完成\n- [x] 已完成\n");
  expect(container.querySelector('[aria-label="未完成"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="已完成"]')).toBeTruthy();
  expect(container.textContent).toContain("未完成");
  expect(container.textContent).toContain("已完成");
  // 有勾选框就不再画圆点，否则会出现「• ✓ 事项」两个标记。
  expect(container.querySelector("ul")?.className).toContain("list-none");
});

it("任务列表：松列表（项间空行）同样保留勾选", () => {
  render("- [ ] 甲\n\n- [x] 乙\n");
  expect(container.querySelector('[aria-label="未完成"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="已完成"]')).toBeTruthy();
});

it("长代码块默认折叠，点开后不再截断", () => {
  const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  render("```js\n" + code + "\n```");
  const toggle = () =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("展开全部"));
  expect(toggle()).toBeTruthy();
  act(() => {
    toggle()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.textContent).toContain("收起");
});
