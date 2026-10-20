// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSshSessions } from "./useSshSessions";
import type { SshConnection } from "../../lib/types";

const h = vi.hoisted(() => ({ invoke: vi.fn(), sequence: 0 }));
vi.mock("../../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conn = { id: "host", name: "服务器", username: "dev", host: "192.0.2.10", port: 22 } as SshConnection;
let api: ReturnType<typeof useSshSessions>, root: Root;
function Probe() { api = useSshSessions(); return null; }
async function connect(options?: Parameters<typeof api.connect>[1]) { await act(async () => { await api.connect(conn, options); }); }
beforeEach(async () => {
  vi.clearAllMocks(); h.sequence = 0;
  h.invoke.mockImplementation(async (cmd: string) => cmd === "ssh_connect" ? `session-${++h.sequence}` : undefined);
  root = createRoot(document.createElement("div")); await act(async () => root.render(<Probe/>));
});
afterEach(async () => { await act(async () => root.unmount()); });

describe("workspace connection activation", () => {
  it("只有分屏副格时点击服务器会创建普通标签，不能把隐藏副格提升为当前标签", async () => {
    await connect({ forSplit: true }); const secondary = api.sessions[0];
    expect(api.activeId).toBeNull();
    await connect();
    expect(api.sessions).toHaveLength(2); expect(api.sessions[0]).toBe(secondary);
    expect(api.sessions.find(s => s.sessionId === api.activeId)?.splitOnly).toBeUndefined();
  });
  it("分屏的断开标签不被普通连接复用", async () => {
    await connect({ forSplit: true });
    await act(async () => api.markClosed(api.sessions[0].sessionId, "断开"));
    const secondary = api.sessions[0]; await connect();
    expect(api.sessions).toHaveLength(2); expect(api.sessions[0]).toBe(secondary);
    expect(api.sessions[1].splitOnly).toBeUndefined();
  });
  it("有普通活标签时直接激活，不重复连接；指定副格重连仍保留身份", async () => {
    await connect({ forSplit: true }); await connect(); const primary = api.sessions[1];
    await connect(); expect(api.activeId).toBe(primary.sessionId); expect(h.sequence).toBe(2);
    const secondary = api.sessions[0];
    await act(async () => api.markClosed(secondary.sessionId, "断开"));
    await connect({ intoTab: secondary.tabId, forSplit: true });
    expect(api.sessions[0].tabId).toBe(secondary.tabId); expect(api.sessions[0].splitOnly).toBe(true);
    expect(api.sessions[0].sessionId).not.toBe(secondary.sessionId); expect(api.activeId).toBe(primary.sessionId);
  });
});
