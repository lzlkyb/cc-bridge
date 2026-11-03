// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSshSessions } from "./useSshSessions";
import { MAX_LIVE_SESSIONS, sessionLimitMessage } from "../../lib/terminalWorkspace";
import type { SshConnection } from "../../lib/types";
import type { ProgramStatus } from "../../lib/terminalProgramStatus";

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

describe("标签 meta 去重（OSC 7501 程序状态）", () => {
  const st = (state: ProgramStatus["state"], extra: Partial<ProgramStatus> = {}): ProgramStatus =>
    ({ state, kind: null, app: "claude-code", title: null, msg: null, progress: null, ...extra });
  it("重复上报同一条状态不产生新对象（CC 每条上报都造新对象，只比引用等于没去重）", async () => {
    const agent = st("working", { progress: 40 });
    await act(async () => api.patchMeta("s1", { agent }));
    const first = api.metaBySession;
    expect(first.s1.agent).toBe(agent);
    await act(async () => api.patchMeta("s1", { agent: { ...agent } }));
    expect(api.metaBySession).toBe(first);
  });
  it("状态 / 进度 / msg 任一变化都要更新（msg 就是 tooltip 里那句「它在问什么」）", async () => {
    await act(async () => api.patchMeta("s1", { agent: st("working", { progress: 40 }) }));
    await act(async () => api.patchMeta("s1", { agent: st("working", { progress: 60 }) }));
    expect(api.metaBySession.s1.agent?.progress).toBe(60);
    await act(async () => api.patchMeta("s1", { agent: st("blocked", { kind: "question", msg: "要继续吗？" }) }));
    expect(api.metaBySession.s1.agent?.state).toBe("blocked");
    await act(async () => api.patchMeta("s1", { agent: st("blocked", { kind: "question", msg: "换了个问题？" }) }));
    expect(api.metaBySession.s1.agent?.msg).toBe("换了个问题？");
  });
  it("🔴 agent: null 是有效写值（断开清零），不能被当成「这个字段没传」", async () => {
    await act(async () => api.patchMeta("s2", { agent: st("working") }));
    expect(api.metaBySession.s2.agent).not.toBeNull();
    await act(async () => api.patchMeta("s2", { agent: null }));
    expect(api.metaBySession.s2.agent).toBeNull();
  });
});

describe("标签未读（agentUnread）：区分「变了」和「你还没看」", () => {
  const st = (state: ProgramStatus["state"], extra: Partial<ProgramStatus> = {}): ProgramStatus =>
    ({ state, kind: null, app: "claude-code", title: null, msg: null, progress: null, ...extra });
  /** 开两个标签，返回 [后台那个, 当前激活那个] 的 sessionId。 */
  async function twoTabs(): Promise<[string, string]> {
    await connect();
    const first = api.sessions[0].sessionId;
    await connect({ newTab: true });
    expect(api.sessions).toHaveLength(2);
    return [first, api.activeId!];
  }

  it("后台标签跑到 blocked / done / error ⇒ 标未读", async () => {
    const [bg] = await twoTabs();
    for (const state of ["blocked", "done", "error"] as const) {
      await act(async () => api.patchMeta(bg, { agent: st(state) }));
      expect(api.metaBySession[bg].agentUnread, state).toBe(true);
      await act(async () => api.patchMeta(bg, { agentUnread: false })); // 复位，测下一档
    }
  });

  it("🔴 working 不标未读：每个后台在跑的标签都变未读，未读就失去区分度", async () => {
    const [bg] = await twoTabs();
    await act(async () => api.patchMeta(bg, { agent: st("working", { progress: 30 }) }));
    expect(api.metaBySession[bg].agentUnread).toBe(false);
  });

  it("切到该标签 ⇒ 已读（切过去就算看过了）", async () => {
    const [bg] = await twoTabs();
    await act(async () => api.patchMeta(bg, { agent: st("done") }));
    await act(async () => api.setActiveId(bg));
    expect(api.metaBySession[bg].agentUnread).toBe(false);
  });

  it("🔴 离开标签时把刚看过的那个也清掉：否则「盯着跑完再切走」会永久高亮", async () => {
    const [bg, front] = await twoTabs();
    await act(async () => api.setActiveId(bg));
    await act(async () => api.patchMeta(bg, { agent: st("done") }));
    expect(api.metaBySession[bg].agentUnread).toBe(true); // 正停在它上面时仍先标未读
    await act(async () => api.setActiveId(front)); // 切走
    expect(api.metaBySession[bg].agentUnread).toBe(false);
  });

  it("🔴 CC 周期重发同一条状态不把刚清掉的未读重新点亮", async () => {
    const [bg] = await twoTabs();
    const done = st("done");
    await act(async () => api.patchMeta(bg, { agent: done }));
    await act(async () => api.setActiveId(bg));
    expect(api.metaBySession[bg].agentUnread).toBe(false);
    await act(async () => api.patchMeta(bg, { agent: { ...done } })); // 同值重发
    expect(api.metaBySession[bg].agentUnread).toBe(false);
  });

  it("同一档内 msg 变了是新问题 ⇒ 重新标未读（blocked 从一个提问换成另一个）", async () => {
    const [bg] = await twoTabs();
    await act(async () => api.patchMeta(bg, { agent: st("blocked", { kind: "permission", msg: "允许 rm 吗？" }) }));
    await act(async () => api.setActiveId(bg));
    await act(async () => api.patchMeta(bg, { agent: st("blocked", { kind: "permission", msg: "允许 push 吗？" }) }));
    expect(api.metaBySession[bg].agentUnread).toBe(true);
  });
});

describe("关标签：延迟断开 + 撤销（A+D）", () => {
  it("🔴 关掉活着的标签不立刻断开：窗口期内连接还在，撤销才能把 shell 原样拿回来", async () => {
    await connect();
    const id = api.sessions[0].sessionId;
    h.invoke.mockClear();
    h.toast.mockClear();
    await act(async () => api.closeTab(id));
    expect(api.sessions).toHaveLength(0);
    expect(h.invoke).not.toHaveBeenCalledWith("ssh_disconnect", { sessionId: id });
    const last = h.toast.mock.calls[h.toast.mock.calls.length - 1] as unknown as [string, string, { label: string; onClick: () => void }];
    const action = last[2];
    expect(action.label).toBe("撤销");
    await act(async () => action.onClick());
    expect(api.sessions.map((s) => s.sessionId)).toEqual([id]);
    expect(api.activeId).toBe(id);
  });

  it("关掉已断开的标签不给撤销：后端早没连接了，要它回来是「重连」不是「撤回」", async () => {
    await connect();
    const id = api.sessions[0].sessionId;
    await act(async () => api.markClosed(id, "网络断开"));
    h.toast.mockClear();
    await act(async () => api.closeTab(id));
    expect(api.sessions).toHaveLength(0);
    expect(h.toast).not.toHaveBeenCalled();
  });
});
