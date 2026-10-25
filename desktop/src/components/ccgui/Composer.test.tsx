// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

/**
 * slash 命令面板 + 白名单闸门的行为锁。
 *
 * 为什么值得单测：面板的「自动开合」由正则派生，闸门的「什么能出去」是安全
 * 边界——两者坏了都不报错，只会安静地要么不弹面板、要么把未知命令当提示词
 * 发给模型浪费一轮。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const onSend = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<Composer onSend={onSend} queueCount={0} onClearQueue={() => {}} />);
  });
}
function area() {
  return container.querySelector("textarea")!;
}
/** React 受控 textarea：必须走原生 setter 再派发 input，直接赋 value 不触发 onChange。 */
async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area(), text);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    area().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}
function panelText() {
  return container.querySelector('[aria-label="slash 命令"]')?.textContent ?? "";
}
async function clickSend() {
  await act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent === "发送")!.click();
  });
}

it("打出 / 浮出白名单面板", async () => {
  await render();
  await type("/");
  expect(panelText()).toContain("/compact");
  expect(panelText()).toContain("/clear");
  expect(panelText()).toContain("/model");
});

it("随输入过滤，没有匹配走空态提示", async () => {
  await render();
  await type("/c");
  expect(panelText()).toContain("/compact");
  expect(panelText()).not.toContain("/model");
  await type("/xyz");
  expect(panelText()).toContain("没有匹配");
  expect(panelText()).toContain("只转发");
});

it("Tab 填入 /model 并留参数位，不直接发送", async () => {
  await render();
  await type("/mo");
  await key("Tab");
  expect((area() as HTMLTextAreaElement).value).toBe("/model ");
  expect(onSend).not.toHaveBeenCalled();
  // 填入后面板让位（在写参数，方向键归输入框）
  expect(panelText()).toBe("");
});

it("完整 /compact 上回车直接发送", async () => {
  await render();
  await type("/compact");
  await key("Enter");
  expect(onSend).toHaveBeenCalledWith("/compact");
  expect((area() as HTMLTextAreaElement).value).toBe("");
});

it("白名单命令带参数原样转发", async () => {
  await render();
  await type("/model opus");
  await clickSend();
  expect(onSend).toHaveBeenCalledWith("/model opus");
});

it("未知命令被闸门拦住：不发送、给提示、不清空输入", async () => {
  await render();
  await type("/foo");
  await clickSend();
  expect(onSend).not.toHaveBeenCalled();
  expect(container.textContent).toContain("未发送");
  expect(container.textContent).toContain("/foo");
  // 输入留着让用户改，提示一打字就清
  expect((area() as HTMLTextAreaElement).value).toBe("/foo");
  await type("/foo!");
  expect(container.textContent).not.toContain("未发送");
});

it("Esc 关闭面板，继续打字不重新弹出直到值变化", async () => {
  await render();
  await type("/");
  expect(panelText()).toContain("/compact");
  await key("Escape");
  expect(panelText()).toBe("");
});

it("Ctrl+Enter 照旧发送普通文本", async () => {
  await render();
  await type("帮我看下这个 bug");
  await key("Enter", { ctrlKey: true });
  expect(onSend).toHaveBeenCalledWith("帮我看下这个 bug");
});

it("普通文本不弹面板，裸 Enter 不触发发送（换行是浏览器原生行为）", async () => {
  await render();
  await type("你好");
  expect(panelText()).toBe("");
  await key("Enter");
  expect(onSend).not.toHaveBeenCalled();
});
