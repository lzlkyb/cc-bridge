// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTabCloseUndo } from "./useTabCloseUndo";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { SshConnection } from "../../lib/types";

const m = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: m.invoke }));
vi.mock("../ui/toast", () => ({ toast: m.toast }));

const conn = { id: "c1", name: "示例机", host: "192.0.2.10" } as SshConnection;
const tab = (id: string, closedReason: string | null = null): SshSessionRef => ({
  sessionId: id,
  tabId: `t-${id}`,
  conn,
  closedReason,
});

let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useTabCloseUndo>;
let rendered: SshSessionRef[] = [];
let active: string | null = null;

function Probe({ initial }: { initial: SshSessionRef[] }) {
  const [list, setList] = useState(initial);
  const [cur, setCur] = useState<string | null>(null);
  const patch = useCallback((fn: (p: SshSessionRef[]) => SshSessionRef[]) => setList(fn), []);
  api = useTabCloseUndo(patch, setCur);
  rendered = list;
  active = cur;
  return <span>{list.map((s) => s.sessionId).join(",")}</span>;
}

async function mount(initial: SshSessionRef[]) {
  await act(async () => root.render(<Probe initial={initial} />));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.invoke.mockClear();
  m.toast.mockClear();
  rendered = [];
  active = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await mount([tab("a"), tab("b"), tab("c")]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("窗口内不断开：连接还留着，撤销才有东西可撤", async () => {
  await act(async () => api.schedule(tab("b"), 1));
  await act(async () => vi.advanceTimersByTime(7999));
  expect(m.invoke).not.toHaveBeenCalled();
});

it("🔴 到点必须真的断开：gc_ssh_sessions 不杀活跃会话，漏了就一直挂着占服务器 MaxSessions", async () => {
  await act(async () => api.schedule(tab("b"), 1));
  await act(async () => vi.advanceTimersByTime(8000));
  expect(m.invoke).toHaveBeenCalledExactlyOnceWith("ssh_disconnect", { sessionId: "b" });
});

it("撤销：取消断开、按原位置塞回列表并激活", async () => {
  await act(async () => api.schedule(tab("b"), 1));
  await act(async () => api.undo("b"));
  expect(rendered.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  expect(active).toBe("b");
  // 定时器已取消，窗口过了也不会再断
  await act(async () => vi.advanceTimersByTime(20000));
  expect(m.invoke).not.toHaveBeenCalled();
});

it("🔴 撤销必须回到原位置：扔到末尾的话用户找不着它了", async () => {
  await act(async () => api.schedule(tab("a"), 0));
  await act(async () => api.undo("a"));
  expect(rendered.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
});

it("连点撤销只恢复一份（幂等）", async () => {
  await act(async () => api.schedule(tab("b"), 1));
  await act(async () => api.undo("b"));
  await act(async () => api.undo("b"));
  expect(rendered.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
});

it("通知里带「撤销」动作，且驻留时长与窗口等长（否则窗口还开着却没有入口）", async () => {
  await act(async () => api.schedule(tab("b"), 1));
  const [, variant, action, lifetime] = m.toast.mock.calls[0] as unknown as [
    string,
    string,
    { label: string; onClick: () => void },
    number,
  ];
  expect(variant).toBe("info");
  expect(action.label).toBe("撤销");
  expect(lifetime).toBe(8000);
  await act(async () => action.onClick());
  expect(rendered.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
});

it("🔴 宿主卸载时窗口没走完：立刻断开，否则定时器随组件一起消失、连接永久泄漏", async () => {
  await act(async () => api.schedule(tab("b"), 1));
  await act(async () => root.unmount());
  expect(m.invoke).toHaveBeenCalledExactlyOnceWith("ssh_disconnect", { sessionId: "b" });
  // 卸载后重建 root，供 afterEach 的 unmount 调用
  root = createRoot(document.createElement("div"));
});
