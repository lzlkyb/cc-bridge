// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalVisibility } from "./useTerminalVisibility";

const h = vi.hoisted(() => ({ resize: vi.fn(), focus: vi.fn(), fit: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: h.resize }));
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
