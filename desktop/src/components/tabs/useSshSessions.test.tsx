// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSshSessions } from "./useSshSessions";
import { MAX_LIVE_SESSIONS, sessionLimitMessage } from "../../lib/terminalWorkspace";
import type { SshConnection } from "../../lib/types";

const h = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), sequence: 0 }));
vi.mock("../../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("../ui/toast", () => ({ toast: h.toast }));
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

describe("软件会话数上限", () => {
  /** 每条命令用不同 connectionId：同一 id 的重复连接会被「重入闸」吃掉，测不到上限。 */
  const nth = (i: number) => ({ ...conn, id: `host-${i}` }) as SshConnection;
  const fill = async (n: number) => {
    for (let i = 0; i < n; i++) await act(async () => { await api.connect(nth(i)); });
  };

  it("尚未完成的连接也占额度，不同服务器并发连接不能越过上限", async () => {
    await fill(MAX_LIVE_SESSIONS - 1);
    let finish!: (id: string) => void;
    h.invoke.mockClear();
    h.invoke.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    let first!: ReturnType<typeof api.connect>;
    act(() => { first = api.connect(nth(50)); });
    await act(async () => { await api.connect(nth(51)); });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { finish("final-session"); await first; });
    expect(api.sessions.filter(session => !session.closedReason)).toHaveLength(MAX_LIVE_SESSIONS);
  });

  it("🔴 到顶后不再发 ssh_connect，只给一句能执行的提示", async () => {
    await fill(MAX_LIVE_SESSIONS);
    expect(api.sessions.filter(s => !s.closedReason)).toHaveLength(MAX_LIVE_SESSIONS);
    h.invoke.mockClear(); h.toast.mockClear();
    await act(async () => { await api.connect(nth(MAX_LIVE_SESSIONS)); });
    // 关键：不是「发出去等远端拒」——远端只回一句失败，看不出是上限
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(String(h.toast.mock.calls[0][0])).toContain("已达");
    expect(api.sessions).toHaveLength(MAX_LIVE_SESSIONS);
  });

  it("已断开的标签不占额度：断开一个后又能开新的", async () => {
    await fill(MAX_LIVE_SESSIONS);
    await act(async () => api.markClosed(api.sessions[0].sessionId, "断开"));
    expect(api.sessions.filter(s => !s.closedReason)).toHaveLength(MAX_LIVE_SESSIONS - 1);
    h.invoke.mockClear();
    await act(async () => { await api.connect(nth(MAX_LIVE_SESSIONS)); });
    expect(h.invoke).toHaveBeenCalledWith("ssh_connect", expect.anything());
    expect(api.sessions.filter(s => !s.closedReason)).toHaveLength(MAX_LIVE_SESSIONS);
  });

  it("阈值判断是纯函数，边界不上浮", () => {
    expect(sessionLimitMessage(MAX_LIVE_SESSIONS - 1)).toBeNull();
    expect(sessionLimitMessage(MAX_LIVE_SESSIONS)).toContain(String(MAX_LIVE_SESSIONS));
    expect(sessionLimitMessage(MAX_LIVE_SESSIONS + 3)).toContain("软件上限");
  });
});

describe("标签重命名", () => {
  it("renameTab 写 label；空串（含纯空格）恢复默认名", async () => {
    await connect();
    const tabId = api.sessions[0].tabId;
    await act(async () => api.renameTab(tabId, "构建"));
    expect(api.sessions[0].label).toBe("构建");
    await act(async () => api.renameTab(tabId, "   "));
    expect(api.sessions[0].label).toBeUndefined();
  });
  it("addRestoredTab 接受 label：重启后用户起过的名字还在", async () => {
    await act(async () => api.addRestoredTab(conn, "调试"));
    expect(api.sessions[0].label).toBe("调试");
    expect(api.sessions[0].closedReason).toBe("restored");
  });
});
