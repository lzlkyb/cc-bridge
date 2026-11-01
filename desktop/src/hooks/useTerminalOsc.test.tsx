// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const invokeMock = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args: { sessionId: string; data: string }) => undefined),
);
vi.mock("../lib/tauri", () => ({ invoke: invokeMock }));

import { sendTerminalUserInput } from "../lib/terminalUserInput";
import { useTerminalOsc, type OscState } from "./useTerminalOsc";
import { DANCE, ECHO_ON_CMD, PROBE_ECHO_OFF_CMD } from "../lib/terminalSttyDance";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let currentSession = "";
let osc: { state: OscState };
let dataCbs: ((d: string) => void)[] = [];
let oscCbs = new Map<number, (d: string) => boolean>();
let root: Root, host: HTMLDivElement;
const termRef: { current: Terminal | null } = { current: null };

function makeTerm(): Terminal {
  dataCbs = [];
  oscCbs = new Map();
  return {
    cols: 200,
    rows: 24,
    write: () => undefined,
    onData: (cb: (d: string) => void) => {
      dataCbs.push(cb);
      return { dispose() {} };
    },
    parser: {
      registerOscHandler: (code: number, cb: (d: string) => boolean) => {
        oscCbs.set(code, cb);
        return { dispose() {} };
      },
    },
    buffer: { active: { type: "normal" } },
  } as unknown as Terminal;
}

function Harness({ sessionId }: { sessionId: string }) {
  currentSession = sessionId;
  osc = useTerminalOsc({ sessionId, enabled: true, closed: false, termRef });
  return null;
}

/** 所有发往远端的 ssh_input 数据（按调用顺序）。 */
const sent = () => invokeMock.mock.calls.map((c) => c[1].data);
const last = (arr: string[]) => arr[arr.length - 1];
/** 用户敲键：所有 onData 订阅者都喂一遍（剥除器与注入钩子各挂了一个）。 */
const type = (data: string) => {
  void sendTerminalUserInput(currentSession, data);
  dataCbs.forEach((cb) => cb(data));
};
const advance = async (ms: number) => act(async () => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  termRef.current = makeTerm();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("ECHO 关闭期的用户输入", () => {
  it("准备开始前的工具栏粘贴也会阻止后续注入", async () => {
    act(() => root.render(<Harness sessionId="osc-early-paste" />));
    await act(async () => sendTerminalUserInput("osc-early-paste", "echo once\r"));
    await advance(DANCE.PROBE_DELAY);
    expect(sent()).toEqual(["echo once\r"]);
    expect(osc.state).toBe("skipped");
  });
  it("卸载时恢复回显并排出缓冲，解除输入拦截", async () => {
    act(() => root.render(<Harness sessionId="osc-unmount-input" />));
    await advance(DANCE.PROBE_DELAY);
    act(() => type("echo once\r"));
    act(() => root.render(null));
    expect(sent().filter(data => data === "echo once\r")).toHaveLength(1);
    await sendTerminalUserInput("osc-unmount-input", "after");
    expect(last(sent())).toBe("after");
  });
  it("真实发送通道在准备期不提前发送整条命令，恢复后只执行一次", async () => {
    act(() => root.render(<Harness sessionId="osc-real-input" />));
    await advance(DANCE.PROBE_DELAY);
    // 模拟 session.onData：发送通道先收到，OSC 观察者随后收到。
    act(() => type("touch /tmp/once\r"));
    expect(sent().filter(data => data === "touch /tmp/once\r")).toHaveLength(0);
    await advance(DANCE.REPLAY_DELAY);
    expect(sent().filter(data => data === "touch /tmp/once\r")).toHaveLength(1);
  });
  it("🔴 敲键不再被拼进恢复命令，而是缓冲后原样重放", async () => {
    act(() => root.render(<Harness sessionId="osc-replay" />));
    // t0：合并探针发出（这一条同时关 ECHO 与报 shell 名）。
    await advance(DANCE.PROBE_DELAY);
    expect(sent()).toEqual([` ${PROBE_ECHO_OFF_CMD}\n`]);

    // ECHO 已关：用户开始敲 `ls`（屏上什么都看不见，本地也不回显）。
    act(() => type("l"));
    act(() => type("s"));

    const during = sent();
    // 恢复命令必须带 ^U 清行，否则远端收到的是 `ls stty echo`
    expect(last(during)).toBe(`\x15 ${ECHO_ON_CMD}\n`);
    expect(during.some((d) => d.includes(`ls ${ECHO_ON_CMD}`))).toBe(false);
    // 用户的字还没丢，只是还没发出去
    expect(during.some((d) => d === "ls")).toBe(false);
    expect(osc.state).toBe("skipped");

    // ECHO 恢复后重放，顺序原样
    await advance(DANCE.REPLAY_DELAY);
    expect(last(sent())).toBe("ls");
    expect(osc.state).toBe("skipped");
  });

  it("没敲键时恢复命令保持原样（不塞 ^U）", async () => {
    act(() => root.render(<Harness sessionId="osc-clean" />));
    await advance(DANCE.PROBE_DELAY);
    // 探针回执：shell=bash → 舞步后半场，收尾发干净的 stty echo
    act(() => {
      oscCbs.get(1337)?.("Shell=bash");
    });
    await advance(DANCE.HOOK_DELAY + DANCE.KICK_DELAY + DANCE.RESTORE_DELAY);
    const restore = last(sent())!;
    expect(restore).toContain(ECHO_ON_CMD);
    expect(restore.startsWith("\x15")).toBe(false);
  });
});
