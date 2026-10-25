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
