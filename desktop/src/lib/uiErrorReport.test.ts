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

it("超长堆栈被截断但保留头部", () => {
  const error = new Error("长堆栈");
  error.stack = `Error: 长堆栈\n${"x".repeat(9000)}`;
  reportUiError("bootstrap", error);

  const [, args] = mocks.invoke.mock.calls[0] as [string, Record<string, string>];
  expect(args.detail.length).toBeLessThanOrEqual(2000 + "…（已截断）".length);
  expect(args.detail.endsWith("…（已截断）")).toBe(true);
  expect(args.detail.startsWith("Error: 长堆栈")).toBe(true);
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
