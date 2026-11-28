// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
// 直接 mock 底层而不是 `lib/tauri`：上报模块刻意只依赖 Tauri 核心，
// 免得「报错通道」自己先被 toast / 组件链路上的错误拖下水。
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { __resetUiErrorDedupeForTests, installGlobalErrorReporting, reportUiError } from "./uiErrorReport";

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  __resetUiErrorDedupeForTests();
});

it("把来源、消息与上下文一起报给后端", () => {
  reportUiError("ErrorBoundary", new TypeError("boom"), "at <App>");

  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  const [cmd, args] = mocks.invoke.mock.calls[0] as [string, Record<string, string>];
  expect(cmd).toBe("report_ui_error");
  expect(args.source).toBe("ErrorBoundary");
  expect(args.message).toBe("TypeError: boom");
  expect(args.detail).toContain("at <App>");
  expect(args.detail).toContain("boom");
});

it("同一处反复抛出的异常 60 秒内只报一次", () => {
  // 渲染循环里同一个错误可能每帧抛一次；不去重会在几秒内把日志冲干净。
  reportUiError("ErrorBoundary", new Error("same"));
  reportUiError("ErrorBoundary", new Error("same"));

  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("同一句话从不同位置抛出时算两条线索", () => {
  reportUiError("window.onerror", new Error("same"));
  reportUiError("ErrorBoundary", new Error("same"));

  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("不同异常分别上报", () => {
  reportUiError("window.onerror", new Error("first"));
  reportUiError("window.onerror", new Error("second"));

  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("非 Error 的拒绝原因也能描述出来", () => {
  reportUiError("unhandledrejection", "纯字符串原因");

  const [, args] = mocks.invoke.mock.calls[0] as [string, Record<string, string>];
  expect(args.message).toBe("纯字符串原因");
});

/** 与后端 `sanitize` 同口径的字节数：换行按字面 `\n` 两字节算。 */
function loggedBytes(text: string): number {
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\r") total += 2;
    else if (ch === "\t") total += 1;
    else if (code < 0x20 || code === 0x7f) total += 0;
    else if (code <= 0x7f) total += 1;
    else if (code <= 0x7ff) total += 2;
    else if (code <= 0xffff) total += 3;
    else total += 4;
  }
  return total;
}

it("超长堆栈被截断但保留头部，且不超过后端的字节上限", () => {
  const error = new Error("长堆栈");
  error.stack = `Error: 长堆栈\n${"x".repeat(9000)}`;
  reportUiError("bootstrap", error);

  const [, args] = mocks.invoke.mock.calls[0] as [string, Record<string, string>];
  // 后端按字节截：这里必须用同口径断言，否则中文堆栈会「量着没超、到后端又被截一次」。
  expect(loggedBytes(args.detail)).toBeLessThanOrEqual(2000);
  expect(args.detail.endsWith("…（已截断）")).toBe(true);
  expect(args.detail.startsWith("Error: 长堆栈")).toBe(true);
});

it("中文堆栈按字节截断，后端不会再截第二次", () => {
  const error = new Error("中文堆栈");
  error.stack = `Error: 中文堆栈\n${"错".repeat(3000)}`;
  reportUiError("bootstrap", error);

  const [, args] = mocks.invoke.mock.calls[0] as [string, Record<string, string>];
  expect(loggedBytes(args.detail)).toBeLessThanOrEqual(2000);
  // 只应有一个截断标记。出现两个说明前端按字符量、后端按字节量，两边口径不一致。
  expect(args.detail.split("…（已截断）")).toHaveLength(2);
  expect(args.detail.startsWith("Error: 中文堆栈")).toBe(true);
});

it("换行多时也不超上限（后端会把换行压成两个字面字符）", () => {
  const error = new Error("多行");
  error.stack = Array.from({ length: 500 }, () => "行").join("\n");
  reportUiError("bootstrap", error);

  const [, args] = mocks.invoke.mock.calls[0] as [string, Record<string, string>];
  // 每行 3 字节 + 换行压平后 2 字节：只按原始字符量算会低估约 1/3。
  expect(loggedBytes(args.detail)).toBeLessThanOrEqual(2000);
  expect(args.detail.split("…（已截断）")).toHaveLength(2);
});

it("上报通道自己失败时不能把异常抛给调用方", () => {
  mocks.invoke.mockRejectedValue(new Error("ipc 已断开"));

  expect(() => reportUiError("bootstrap", new Error("触发点"))).not.toThrow();
});

it("装上全局兜底后，window.onerror 会被上报", () => {
  installGlobalErrorReporting();
  const error = new Error("事件回调里抛的");
  window.dispatchEvent(
    new ErrorEvent("error", { error, message: error.message, filename: "app.js", lineno: 12, colno: 3 }),
  );

  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  const [, args] = mocks.invoke.mock.calls[0] as [string, Record<string, string>];
  expect(args.source).toBe("window.onerror");
  expect(args.detail).toContain("app.js:12:3");
});
