import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../lib/tauri";
import { hookCmd } from "../lib/terminalStatusbar";
import { attachOscHandlers } from "../lib/terminalOscAttach";
import { interceptTerminalUserInput } from "../lib/terminalUserInput";
import {
  attachEchoStripWhenReady,
  claimInjection,
  DANCE,
  PROBE_ECHO_OFF_CMD,
  danceNext,
  restoreEcho,
  restoreEchoOnTeardown,
  runProbeGate,
  tuiOnScreen,
  type DancePhase,
} from "../lib/terminalSttyDance";

import type { OscState, TerminalStatus } from "../lib/terminalOscTypes";

// 类型真源已搬到 lib（见 lib/terminalOscTypes.ts 头注）；这里保留重导出，调用方无需改 import。
export type { OscState, TerminalStatus };

interface Args {
  /** 会话 id。变化时（含重连）重置状态并重新探测。 */
  sessionId: string;
  /** 注入开关（设置项，默认开）。false = 完全不往远端写任何东西。 */
  enabled: boolean;
  /** 会话已断开。 */
  closed: boolean;
  termRef: MutableRefObject<Terminal | null>;
}

/**
 * 远端提示符钩子：注入 + OSC 解析（解析层在 lib/terminalOscAttach.ts）。
 *
 * 注入是往一个**活着的 shell** 里打字，只在会话刚建立、用户一个字都还没敲时做一次
 * （VS Code / iTerm2 / Warp 通行做法），`typedRef` 兜底：收到过一次用户输入即永久放弃。
 * 🔴 另两条硬前置见 lib/terminalSttyDance.ts 的 `claimInjection` / `tuiOnScreen`：
 * 同一会话只注入一次（HMR / 重挂 / 会话恢复都会重跑本 effect），且屏幕上有全屏 TUI 时
 * 绝不注入——否则命令会被 TUI 的输入行吃掉并显示出来（2026-10-16 报障）。
 * 回显治理与时序见 lib/terminalSttyDance.ts 头注；restore 单次消费（echoOffRef）：
 * ECHO 已恢复后再发 `stty echo` 会被回显成第二行残渣。
 */
export function useTerminalOsc({ sessionId, enabled, closed, termRef }: Args): {
  status: TerminalStatus;
  state: OscState;
} {
  const [status, setStatus] = useState<TerminalStatus>({
    cwd: null,
    branch: null,
    exitCode: null,
    lastCmdMs: null,
    cmdSeq: 0,
  });
  const [state, setState] = useState<OscState>("pending");
  // 用户是否已经在本次会话里敲过字。敲过就永不注入（见文件头注释）。
  const typedRef = useRef(false);
  const probeOkRef = useRef(false);
  const readyRef = useRef(false);
  // ECHO 是否处于关闭期：restore 的单次消费闸门（红线见 lib/terminalSttyDance.ts）。
  const echoOffRef = useRef(false);
  // Buffer user input before IPC until ECHO is restored.
  const collectingRef = useRef(false);
  const typedBufRef = useRef("");
  // User input aborts preparation; distinguish that from an unsupported shell.
  const abortRef = useRef<((reason?: "skipped") => void) | null>(null);
  // 探针回执到达时的续步回调：hook/kick/restore 时序从这里接棒。
  const probeGoRef = useRef<(() => void) | null>(null);
  // OSC handlers outlive renders and must read the latest injection setting.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const reset = useCallback(() => {
    typedRef.current = false;
    probeOkRef.current = false;
    readyRef.current = false;
    echoOffRef.current = false;
    collectingRef.current = false;
    typedBufRef.current = "";
    abortRef.current = null;
    setStatus({ cwd: null, branch: null, exitCode: null, lastCmdMs: null, cmdSeq: 0 });
  }, []);

  // ── 注册 OSC 处理器 ──
  // 解析与「字节→语义」的映射在 lib/terminalOscAttach.ts；这里只接状态。
  // 挂在 term 实例上，与 sessionId 无关（OSC 数据来自这个终端的输出流），故按终端实例
  // 注册一次，重连不重挂。
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    let dispose: (() => void) | null = null;

    const attach = () => {
      const term = termRef.current;
      // Retry without depending on the terminal creation effect running first.
      if (!term) {
        // 30 帧（约 0.5s）还没就绪就放弃：此时不是「远端不支持」，而是 xterm 实例本身
        // 没建好（罕见）。给独立态，避免状态栏把「终端未就绪」误报成「远端不支持」。
        if (tries++ > 30) {
          setState((s) => (s === "pending" ? "termNotReady" : s));
          return;
        }
        raf = requestAnimationFrame(attach);
        return;
      }
      dispose = attachOscHandlers(term, {
        enabled: () => enabledRef.current,
        onCwd: (cwd) => {
          setStatus((s) => ({ ...s, cwd }));
          setState("ready");
        },
        onCommandStart: () => {
          readyRef.current = true; // 舞步钩子超时判死用
          setState("ready");
        },
        onCommandEnd: (code, durMs) => {
          setStatus((s) => ({
            ...s,
            exitCode: code,
            lastCmdMs: durMs ?? s.lastCmdMs,
            cmdSeq: s.cmdSeq + 1,
          }));
          setState("ready");
        },
        onBranch: (git) => setStatus((s) => ({ ...s, branch: git })),
        onProbeOk: () => {
          probeOkRef.current = true;
          probeGoRef.current?.(); // 回执到达 → 舞步后半场接棒
        },
        onProbeUnsupported: () => abortRef.current?.(),
        onUserInput: () => {
          // Buffered bytes were already observed by the transport interceptor.
          if (collectingRef.current) return;
          typedRef.current = true;
          abortRef.current?.("skipped");
        },
      });
    };
    attach();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      dispose?.();
    };
  }, [termRef]);

  // ── 残渣剥除器：随**终端实例**常驻且幂等 ──
  // 🔴 不能挂在会话 effect 里：它换开关/断开/HMR 时会重跑，cleanup 撤包装 + claimInjection
  // 提前 return = 整场会话再没剥除器，ConPTY 重绘时残渣「又自己输入一遍」（2026-10-28 报障）。
  useEffect(() => {
    const handle = attachEchoStripWhenReady(termRef);
    return () => handle.cancel();
  }, [termRef]);

  // ── 会话流程：stty 舞步（探针 → 注入 → kick 全静默，异常路径强制恢复 ECHO）──
  useEffect(() => {
    if (!enabled) {
      setState("off");
      return;
    }
    if (closed) return; // 断开：保留最后一次的状态，不再折腾
    // 🔴 同一会话只注入一次（台账见 lib/terminalSttyDance.claimInjection）：本 effect 会在
    // HMR / 重挂 / 会话恢复时重跑，重跑再打一遍命令就会打进正在运行的 TUI 输入行。
    if (!claimInjection(sessionId)) {
      setState("ready");
      return;
    }
    reset();
    setState("pending");
    const send = (data: string): Promise<void> => invoke("ssh_input", { sessionId, data });

    // ── 舞步状态机接线 ──
    let phase: DancePhase = "idle";
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    // 恢复 ECHO。单次消费（echoOffRef 闸门）：第二句 stty echo 会被回显成残渣（红线）。
    // 全部字节组成与「探针被密码提示吃掉」的异常分支都在 lib/terminalSttyDance.restoreEcho。
    const restore = (clean = false) =>
      restoreEcho(
        {
          echoOff: echoOffRef,
          typedBuf: typedBufRef,
          collecting: collectingRef,
          abort: abortRef,
          term: termRef,
          send: (data) => void send(data).catch(() => {}),
          at,
          onRestoreSent: () => {
            phase = danceNext(phase, "restoreSent").phase;
          },
        },
        clean,
      );
    // 异常退出：恢复 ECHO + 降级（已 ready 则不动）。
    // reason="skipped"：用户自己开始输入了，不是「远端不支持」——状态栏不能把话说成缺陷。
    const abortDance = (reason?: "skipped") => {
      restore();
      phase = danceNext(phase, "abort").phase;
      const next = reason === "skipped" ? "skipped" : "unsupported";
      setState((s) => (s === "pending" ? next : s));
    };
    abortRef.current = abortDance;
    const releaseInput = interceptTerminalUserInput(sessionId, (data) => {
      typedRef.current = true;
      const buffered = collectingRef.current;
      if (buffered) typedBufRef.current += data;
      abortRef.current?.("skipped");
      return buffered;
    });

    const fireProbe = () => {
      const term = termRef.current;
      // 🔴 折行安全阀：剥除器单行匹配，token 被 PTY 折成两行就永远命中不了 ⇒ 宁可不注入。
      // 此时 echoOffRef 还是 false，abortDance 不会发多余的 stty echo。
      if (!term || term.cols < PROBE_ECHO_OFF_CMD.length + 4) {
        abortDance();
        return;
      }
      echoOffRef.current = true;
      // ECHO 一关就开始攒用户的按键（restore 里重放）。
      collectingRef.current = true;
      // 🔴 前导空格：bash HISTCONTROL=ignoreboth 忽略带空格的命令，不进 history（zsh 尽力而为）。
      // 🔴 这一条同时关回显与报 shell 名：**回执到达 = shell 已 ready 且 ECHO 已关**，钩子才允许发。
      void send(` ${PROBE_ECHO_OFF_CMD}\n`).catch(() => {
        // 发送失败 = 字节没到远端，回显从未关——闸门必须复位（否则 restore 补发
        // stty echo 被回显成残渣），并中止舞步。
        echoOffRef.current = false;
        collectingRef.current = false;
        typedBufRef.current = "";
        phase = danceNext(phase, "abort").phase;
        setState("unsupported");
      });
      // 关回显与探针已合并成同一条命令：两态一起推进，hook 仍由回执门禁把守。
      phase = danceNext(phase, "echoOffSent").phase;
      phase = danceNext(phase, "probeSent").phase;
      // 🔴 超时从**真正发出**那一刻算起：闸门可能把探针推后十几秒，
      // 仍按 t0 计时的话会在发出前就判死。
      at(DANCE.PROBE_TIMEOUT, () => {
        if (!probeOkRef.current) abortDance(); // 回执没到：恢复 ECHO + 走 unsupported 降级
      });
    };
    // 发不发、什么时候发由闸门定（读屏：空屏 / 凭据提示 / 改密流程 / 还没静默 → 等下一轮）。
    // 🔴 绝不按固定延时盲发：改密流程里那一行会被当成「当前密码」提交，整条登录报废。
    runProbeGate({
      term: () => termRef.current,
      blockReason: () => (typedRef.current ? "typed" : tuiOnScreen(termRef.current) ? "tui" : null),
      at,
      onFire: fireProbe,
      onAbort: abortDance,
    });
    // 合并探针的回执到达 → 舞步后半场。🔴 此刻 ECHO **已确定关闭**，649 字符钩子才开始
    // 打字（2026-10-28 核心修复：长命令永远排在 `stty -echo` 之后，不再被回显）。
    probeGoRef.current = () => {
      if (phase !== "probeSent") return; // 回执迟到（已超时 abort）：ECHO 已恢复，不再续步
      at(DANCE.HOOK_DELAY, () => {
        if (typedRef.current || phase !== "probeSent") return; // 已中止：不注入
        void send(` ${hookCmd()}\n`).catch(() => abortDance());
        phase = danceNext(phase, "hookSent").phase;
      });
      at(DANCE.HOOK_DELAY + DANCE.KICK_DELAY, () => {
        if (typedRef.current || phase !== "hookSent") return;
        void send("\n").catch(() => {}); // 空回车逼 shell 重绘提示符（echo 关，静默）
        phase = danceNext(phase, "kickSent").phase;
      });
      at(DANCE.HOOK_DELAY + DANCE.KICK_DELAY + DANCE.RESTORE_DELAY, () => restore(true));
      at(DANCE.HOOK_DELAY + DANCE.KICK_DELAY + DANCE.RESTORE_DELAY + DANCE.HOOK_TIMEOUT, () => {
        if (!readyRef.current) abortDance(); // ECHO 已由 restore 恢复，这里只是判死
      });
    };

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      releaseInput();
      // 兜底：卸载/重连/开关切换时 ECHO 仍关闭就尽力恢复一次（会话已死则忽略）。
      // 🔴 剥除器**不在这里撤**——它挂在终端实例上，这条兜底命令的回显仍归它擦。
      restoreEchoOnTeardown({
        echoOff: echoOffRef,
        term: termRef,
        send: (data) => void invoke("ssh_input", { sessionId, data }).catch(() => {}),
      });
      // Flush queued bytes on cleanup; no interceptor may survive this session effect.
      const pendingInput = typedBufRef.current;
      collectingRef.current = false;
      typedBufRef.current = "";
      if (pendingInput && !closed) void send(pendingInput).catch(() => {});
      abortRef.current = null;
      probeGoRef.current = null;
    };
  }, [sessionId, enabled, closed, reset, termRef]);

  return { status, state };
}
