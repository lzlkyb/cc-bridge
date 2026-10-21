import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../lib/tauri";
import {
  PROBE_CMD,
  hookCmd,
  isOsc133A,
  isSupportedShell,
  parseOsc7,
  parseOsc133,
  parseOsc1337,
} from "../lib/terminalStatusbar";
import { navCmdStart, navCmdEnd, navCmdText } from "../lib/terminalCommandNav";
import {
  attachEchoStripWhenReady,
  claimInjection,
  DANCE,
  ECHO_OFF_CMD,
  ECHO_ON_CMD,
  ECHO_ON_CLEAN_CMD,
  danceNext,
  tuiOnScreen,
  type DancePhase,
} from "../lib/terminalSttyDance";

/** 状态栏可见的远端信息。未拿到的字段保持 null，由状态栏决定要不要显示。 */
export interface TerminalStatus {
  /** 远端当前目录（OSC 7）。null = 还没收到。 */
  cwd: string | null;
  /** git 分支（钩子探测）。null = 非 git 仓库或还没收到。 */
  branch: string | null;
  /** 上一条命令退出码（OSC 133;D）。null = 还没收到。 */
  exitCode: number | null;
  /** 上一条命令耗时毫秒（OSC 133;A→D 配对），null = 还没完成过一条命令。 */
  lastCmdMs: number | null;
}

/**
 * 钩子状态机：`pending` 探测中 / `ready` 钩子已生效 / `off` 设置里关了注入 /
 * `unsupported` 远端不是 bash/zsh 或注入出错（**自动降级，不重试**）。
 */
export type OscState = "pending" | "ready" | "off" | "unsupported" | "termNotReady";

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
 * 远端提示符钩子：注入 + OSC 解析。
 *
 * 注入是往一个**活着的 shell** 里打字，只在会话刚建立、用户一个字都还没敲时做一次
 * （VS Code / iTerm2 / Warp 通行做法），`typedRef` 兜底：收到过一次用户输入即永久放弃。
 * 🔴 另两条硬前置见 lib/terminalSttyDance.ts 的 `claimInjection` / `tuiOnScreen`：
 * 同一会话只注入一次（HMR / 重挂 / 会话恢复都会重跑本 effect），且屏幕上有全屏 TUI 时
 * 绝不注入——否则命令会被 TUI 的输入行吃掉并显示出来（2026-10-16 报障）。
 *
 * 回显治理（stty 舞步时序 + 残渣常驻剥除）见 lib/terminalSttyDance.ts 头注与
 * docs/SSH钩子注入回显治理方案.md。restore 单次消费（echoOffRef）：ECHO 已恢复后
 * 再发的 `stty echo` 会被回显成第二行残渣。
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
  });
  const [state, setState] = useState<OscState>("pending");
  // 用户是否已经在本次会话里敲过字。敲过就永不注入（见文件头注释）。
  const typedRef = useRef(false);
  // 探针回执 / 第一条 133;A 的 ref 镜像：舞步定时器触发时读 ref，不读 setState 闭包。
  const probeOkRef = useRef(false);
  const readyRef = useRef(false);
  // ECHO 是否处于关闭期：restore 的单次消费闸门（红线见 lib/terminalSttyDance.ts）。
  const echoOffRef = useRef(false);
  // 用户敲键时的紧急恢复回调（会话 effect 每轮重挂；restore 后置 null）。
  const abortRef = useRef<(() => void) | null>(null);
  // 探针回执到达时的续步回调：hook/kick/restore 时序从这里接棒。
  const probeGoRef = useRef<(() => void) | null>(null);
  // 注入开关的实时镜像：OSC 处理器挂在 term 实例上、生命周期比本 hook 长，必须靠 ref
  // 读到开关最新值，否则关掉探测后处理器仍在偷偷更新状态。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const reset = useCallback(() => {
    typedRef.current = false;
    probeOkRef.current = false;
    readyRef.current = false;
    echoOffRef.current = false;
    abortRef.current = null;
    setStatus({ cwd: null, branch: null, exitCode: null, lastCmdMs: null });
  }, []);

  // ── 注册 OSC 处理器 ──
  // 挂在 term 实例上，与 sessionId 无关（OSC 数据来自这个终端的输出流），故按终端实例
  // 注册一次，重连不重挂。
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    let dispose: (() => void) | null = null;

    const attach = () => {
      const term = termRef.current;
      // term 由 useSshTerminalSession 的创建 effect 填好，那个 effect 声明在更前面，
      // 正常情况下此刻已就绪。这里重试只是不把「hook 声明顺序」当成硬依赖。
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
      const d7 = term.parser.registerOscHandler(7, (data) => {
        if (!enabledRef.current) return true; // 探测已关：吞掉，不更新状态
        const cwd = parseOsc7(data);
        if (cwd) {
          setStatus((s) => ({ ...s, cwd }));
          setState("ready");
        }
        return true; // 已消费：不要让 xterm 再处理
      });
      // 只把「命令结束」当钩子生效的信号（D 带退出码，也是我们要显示的那段）。
      // 顺路喂命令导航：A 钉 marker（跳转锚点），D 配对算耗时给状态栏显示。
      const d133 = term.parser.registerOscHandler(133, (data) => {
        if (!enabledRef.current) return true;
        if (isOsc133A(data)) {
          readyRef.current = true; // 舞步钩子超时判死用
          navCmdStart(term);
          setState((s) => (s === "ready" ? s : "ready"));
          return true;
        }
        const code = parseOsc133(data);
        if (code === null) return false;
        const durMs = navCmdEnd(term, code);
        setStatus((s) => ({ ...s, exitCode: code, lastCmdMs: durMs ?? s.lastCmdMs }));
        setState((s) => (s === "ready" ? s : "ready"));
        return true;
      });
      const d1337 = term.parser.registerOscHandler(1337, (data) => {
        if (!enabledRef.current) return true;
        const { shell, git, cmd } = parseOsc1337(data);
        if (shell) {
          // 🔴 门禁：回执 ≠ 支持——fish/ksh 也能执行探针并回执，钩子（bash 语法）
          // 盲发会在对方屏幕喷语法错误。立即 abortDance：恢复 ECHO 不能等探针超时
          // （PROBE_TIMEOUT 内 ECHO 是关的，用户敲键会隐形）。
          if (isSupportedShell(shell)) {
            probeOkRef.current = true;
            probeGoRef.current?.(); // 回执到达 → 舞步后半场接棒
          } else {
            abortRef.current?.();
          }
        }
        if (git) setStatus((s) => ({ ...s, branch: git })); // 分支按目录缓存：钩子只在 cwd 变化时才发，直接替换（旧分支属旧目录）
        // 命令文本与 133;D 同轮到达（钩子一次 printf 连发），回填到 D 刚填退出码的那一块。
        if (cmd) navCmdText(term, cmd);
        return true;
      });
      // 用户输入监听：一旦敲过字就永久放弃注入；若 ECHO 正处于关闭期，立即恢复。
      const onData = term.onData(() => {
        typedRef.current = true;
        abortRef.current?.();
      });
      dispose = () => {
        d7.dispose();
        d133.dispose();
        d1337.dispose();
        onData.dispose();
      };
    };
    attach();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      dispose?.();
    };
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

    // ── 残渣常驻吞除（fail-open，实现见 lib/terminalSttyDance.ts）──
    // 命令原文全部入 token 表（含两条 stty echo：异常路径会在 ECHO 已恢复后发出，是唯一会自己回显的收尾命令）。
    // 剥离器常驻整个会话：ConPTY 整屏重绘会把残渣反复重发，常驻才每次都吞掉。长 token 排前——
    // `stty echo` 是正常收尾命令的尾部，先擦短串会把前半截留在屏上。
    const stripHandle = attachEchoStripWhenReady(termRef, [ECHO_OFF_CMD, PROBE_CMD, ECHO_ON_CLEAN_CMD, ECHO_ON_CMD]);

    // ── 舞步状态机接线 ──
    let phase: DancePhase = "idle";
    // 恢复 ECHO。单次消费（echoOffRef 闸门）：第二句 stty echo 会被回显成残渣（红线）。
    // 剥离器不在这里撤——它常驻整个会话，撤包装只在 cleanup 里做。
    const restore = (clean = false) => {
      if (!echoOffRef.current) return;
      echoOffRef.current = false;
      abortRef.current = null;
      phase = danceNext(phase, "restoreSent").phase;
      void send(` ${clean ? ECHO_ON_CLEAN_CMD : ECHO_ON_CMD}\n`).catch(() => {});
    };
    // 异常退出：恢复 ECHO + 判 unsupported（已 ready 则不动）。
    const abortDance = () => {
      restore();
      phase = danceNext(phase, "abort").phase;
      setState((s) => (s === "pending" ? "unsupported" : s));
    };
    abortRef.current = abortDance;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

    at(DANCE.PROBE_DELAY, () => {
      if (typedRef.current) {
        abortDance();
        return;
      }
      // 🔴 屏幕上有全屏 TUI（备用屏）时绝不注入：字节会被 TUI 输入行吃进去并显示出来
      // （2026-10-16 报障）。正常新会话此刻停在干净提示符（主屏），不会命中这条。
      if (tuiOnScreen(termRef.current)) {
        abortDance();
        return;
      }
      echoOffRef.current = true;
      // 🔴 每条注入命令都带**前导空格**：bash 的 HISTCONTROL=ignoreboth（Ubuntu 默认）
      // 忽略带空格的命令——不进 history，按 ↑ 翻不到（否则会调出 stty -echo，误执行
      // 还把回显关死）。zsh 需 HIST_IGNORE_SPACE，默认无——尽力而为。空格不影响剥除：
      void send(` ${ECHO_OFF_CMD}\n`).catch(() => {
        // 发送失败 = 字节没到远端，回显从未关——闸门必须复位（否则 restore 补发
        // stty echo 被回显成残渣），并中止舞步免得探针在回显开着时照发。
        echoOffRef.current = false;
        phase = danceNext(phase, "abort").phase;
        setState("unsupported");
      });
      phase = danceNext(phase, "echoOffSent").phase;
    });
    at(DANCE.PROBE_DELAY + DANCE.ECHO_GAP, () => {
      if (typedRef.current || phase !== "echoOffSent") return;
      void send(` ${PROBE_CMD}\n`).catch(() => abortDance());
      phase = danceNext(phase, "probeSent").phase;
    });
    at(DANCE.PROBE_DELAY + DANCE.ECHO_GAP + DANCE.PROBE_TIMEOUT, () => {
      if (probeOkRef.current) return;
      abortDance(); // 回执没到：恢复 ECHO + 走 unsupported 降级
    });
    // 探针回执到达（OSC 处理器回调）→ 舞步后半场：
    probeGoRef.current = () => {
      at(DANCE.HOOK_DELAY, () => {
        if (typedRef.current || phase !== "probeSent") return; // 回执迟到/已中止：不注入
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
      // 兜底：卸载/重连/开关切换时 ECHO 仍关闭就尽力恢复一次（会话已死则 invoke
      // 失败即忽略；PTY 销毁本身也会重置 termios）。
      if (echoOffRef.current) {
        echoOffRef.current = false;
        void invoke("ssh_input", { sessionId, data: ` ${ECHO_ON_CMD}\n` }).catch(() => {});
      }
      abortRef.current = null;
      probeGoRef.current = null;
      stripHandle?.end();
    };
  }, [sessionId, enabled, closed, reset, termRef]);

  return { status, state };
}
