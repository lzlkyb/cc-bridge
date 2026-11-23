// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalVisibility } from "./useTerminalVisibility";
import { ViewActivityContext } from "../lib/viewActivity";

const h = vi.hoisted(() => ({ resize: vi.fn(), focus: vi.fn(), fit: vi.fn(), hidden: false, listeners: new Set<() => void>() }));
vi.mock("../lib/tauri", () => ({ invoke: h.resize }));
vi.mock("../lib/appVisibility", () => ({ isAppHidden: () => h.hidden, subscribeAppVisibility: (fn: () => void) => { h.listeners.add(fn); return () => h.listeners.delete(fn); } }));
const fit = () => h.fit();
let root: Root, host: HTMLDivElement;
function Pane({ name, visible, active, closed = false }: { name: string; visible: boolean; active: boolean; closed?: boolean }) {
  const termRef = useRef({ rows: 24, cols: 80, focus: () => h.focus(name) } as unknown as Terminal);
  const closedRef = useRef(closed); closedRef.current = closed;
  useTerminalVisibility({ visible, active, sessionId: name, termRef, closedRef, doFit: fit });
  return null;
}
const render = (zoom: string | null, selected: string, closed = false) => act(async () => root.render(<>{["a", "b"].map(name => <Pane key={name} name={name} visible={!zoom || zoom === name} active={selected === name} closed={closed} />)}</>));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks(); h.resize.mockResolvedValue(undefined);
  h.hidden = false; h.listeners.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(["a", "b"])("还原 %s 的分屏时另一格仅适配尺寸，不抢输入焦点", async selected => {
  await render(selected, selected); await act(async () => { await vi.runAllTimersAsync(); }); h.focus.mockClear(); h.fit.mockClear();
  await render(null, selected); await act(async () => { await vi.runAllTimersAsync(); });
  expect(h.fit).toHaveBeenCalled(); expect(h.focus).not.toHaveBeenCalled();
  const other = selected === "a" ? "b" : "a";
  await render(null, other); await act(async () => { await vi.runAllTimersAsync(); }); expect(h.focus).toHaveBeenLastCalledWith(other);
});
it("异步聚焦前切走或断开，不聚焦已失效的窗格", async () => {
  await render(null, "a"); await render(null, "b", true);
  await act(async () => { await vi.runAllTimersAsync(); }); expect(h.focus).not.toHaveBeenCalled();
});
it("窗口恢复后仅聚焦当前窗格并重新适配尺寸", async () => {
  await render(null, "b"); await act(async () => { await vi.runAllTimersAsync(); });
  h.focus.mockClear(); h.fit.mockClear();
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.runAllTimersAsync(); });
  expect(h.focus.mock.calls).toEqual([["b"]]);
  expect(h.fit).toHaveBeenCalled();
});
it.each(["input", "textarea", "[contenteditable]", "[role=dialog]"])("窗口恢复不抢走 %s 的焦点", async kind => {
  await render(null, "a"); await act(async () => { await vi.runAllTimersAsync(); }); h.focus.mockClear();
  const el = document.createElement(kind === "input" || kind === "textarea" ? kind : "div");
  if (kind === "[contenteditable]") el.setAttribute("contenteditable", "true");
  if (kind === "[role=dialog]") { el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); }
  el.tabIndex = 0; host.append(el); el.focus();
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.runAllTimersAsync(); });
  expect(h.focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(el);
});
it("原生最小化信号恢复后也能聚焦，后台或断开的窗格不抢焦点", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  await render(null, "a"); await act(async () => { await vi.runAllTimersAsync(); }); h.focus.mockClear();
  await act(async () => { h.hidden = true; h.listeners.forEach(fn => fn()); window.dispatchEvent(new Event("focus")); await vi.runAllTimersAsync(); });
  expect(h.focus).not.toHaveBeenCalled();
  await act(async () => { h.hidden = false; h.listeners.forEach(fn => fn()); await vi.runAllTimersAsync(); });
  expect(h.focus.mock.calls).toEqual([["a"]]);
  h.focus.mockClear();
  await act(async () => root.render(<ViewActivityContext.Provider value={false}><Pane name="hidden-page" visible active /></ViewActivityContext.Provider>));
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.runAllTimersAsync(); });
  expect(h.focus).not.toHaveBeenCalled();
  await render(null, "a", true); await act(async () => { window.dispatchEvent(new Event("focus")); await vi.runAllTimersAsync(); });
  expect(h.focus).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
it("恢复后的延迟聚焦可被再次失焦和卸载取消", async () => {
  await render(null, "a"); await act(async () => { await vi.runAllTimersAsync(); }); h.focus.mockClear();
  await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("blur")); await vi.runAllTimersAsync(); });
  expect(h.focus).not.toHaveBeenCalled();
  await act(async () => { window.dispatchEvent(new Event("focus")); root.render(null); });
  await act(async () => { await vi.runAllTimersAsync(); });
  expect(h.focus).not.toHaveBeenCalled();
  expect(h.listeners.size).toBe(0);
});
