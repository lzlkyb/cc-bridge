import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../lib/tauri";
import {
  HOOK_CMD,
  PROBE_CMD,
  parseOsc7,
  parseOsc133,
  parseOsc1337,
} from "../lib/terminalStatusbar";

/**
 * 状态栏可见的远端信息。未拿到的字段保持 null，由状态栏决定要不要显示。
 */
export interface TerminalStatus {
  /** 远端当前目录（OSC 7）。null = 还没收到。 */
  cwd: string | null;
  /** git 分支（钩子探测）。null = 非 git 仓库或还没收到。 */
  branch: string | null;
  /** 上一条命令退出码（OSC 133;D）。null = 还没收到。 */
  exitCode: number | null;
}

/**
 * 钩子状态机。
 * - `pending`：刚连上，正在探测远端 shell 类型（或已注入、等第一条提示符）
 * - `ready`：收到了 OSC，钩子生效
 * - `off`：用户在设置里关掉了注入
 * - `unsupported`：远端不是 bash/zsh，或注入过程中出错 —— **自动降级，不重试**
 */
export type OscState = "pending" | "ready" | "off" | "unsupported" | "termNotReady";

/** 等远端登录流程（banner / MOTD）走完再探测，太早发会被登录脚本吞掉。 */
const PROBE_DELAY_MS = 900;
/** 探针发出后多久没回执就判定「不是 bash/zsh」。 */
const PROBE_TIMEOUT_MS = 1200;
/** 注入后再发一个空回车，逼 shell 立刻重绘一次提示符 —— 否则要等用户自己按回车才收得到 OSC。 */
const KICK_DELAY_MS = 300;

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
 * ## 为什么是「会话刚连上时注入」而不是「随时注入」
 *
 * `lib/uploadDir.ts` 早就记过一条结论：「终端的 cwd 对我们是不可知的，往终端注入 `pwd`
 * 等于往一个**活着的 shell** 里打字」。那条结论没错，但它说的是会话**进行中**——
 * 那时用户可能正在 vim 里、正在输 sudo 密码，注入的字符会被当成输入。
 *
 * 这里只在**会话刚建立、用户一个字都还没敲**时注入一次：此时远端是干净的提示符，
 * 不存在「打断用户在做的事」的问题。这也是 VS Code / iTerm2 / Warp 的通行做法。
 * 保险起见仍然用 `typedRef` 兜底：只要 xterm 收到过一次用户输入（onData），
 * 本次会话**永久放弃注入**。
 *
 * ## 已知代价（零 Rust 改动的必然结果）
 *
 * 注入是经已有的 `ssh_input` 发的，远端 PTY 的 echo 还开着，所以**回显会留在屏幕上**：
 * 探针一行、钩子一行。要彻底消除回显，得让后端在建立 SSH 连接时就带上远程命令
 * （如 `exec bash --init-file <(...)`），那需要改 `ssh_cmds.rs`。
 * 当前取舍：接受两行回显，换来零后端改动。
 */
export function useTerminalOsc({ sessionId, enabled, closed, termRef }: Args): {
  status: TerminalStatus;
  state: OscState;
} {
  const [status, setStatus] = useState<TerminalStatus>({
    cwd: null,
    branch: null,
    exitCode: null,
  });
  const [state, setState] = useState<OscState>("pending");
  // 探针回执：收到 `Shell=` 才说明远端是 bash/zsh，可以安全地发钩子。
  const [probeOk, setProbeOk] = useState(false);
  // 用户是否已经在本次会话里敲过字。敲过就永不注入（见文件头注释）。
  const typedRef = useRef(false);
  // 注入开关的实时镜像：OSC 处理器挂在 term 实例上、生命周期比本 hook 长，
  // 必须靠 ref 读到开关的最新值，否则关掉探测后处理器仍在偷偷更新状态。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const reset = useCallback(() => {
    typedRef.current = false;
    setProbeOk(false);
    setStatus({ cwd: null, branch: null, exitCode: null });
  }, []);

  // ── 注册 OSC 处理器 ──
  //
  // 挂在 term 实例上，与 sessionId 无关（OSC 数据来自这个终端的输出流），
  // 所以这里**按终端实例注册一次**，重连时不重挂。
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    let dispose: (() => void) | null = null;

    const attach = () => {
      const term = termRef.current;
      // term 由 useSshTerminalSession 的创建 effect 填好，那个 effect 声明在更前面，
      // 正常情况下此刻已就绪。这里重试只是不把「hook 声明顺序」当成硬依赖。
      if (!term) {
        // 30 帧（约 0.5s）还没就绪就放弃注册 OSC 处理器。此时不是「远端不支持」，
        // 而是 xterm 实例本身没建好（罕见：会话创建慢 / 连接失败）。
        // 给一个独立的态，避免状态栏把「终端未就绪」误报成「远端不支持」。
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
      const d133 = term.parser.registerOscHandler(133, (data) => {
        if (!enabledRef.current) return true;
        const code = parseOsc133(data);
        if (code === null) return false;
        setStatus((s) => ({ ...s, exitCode: code }));
        setState((s) => (s === "ready" ? s : "ready"));
        return true;
      });
      const d1337 = term.parser.registerOscHandler(1337, (data) => {
        if (!enabledRef.current) return true;
        const { shell, git } = parseOsc1337(data);
        if (shell) setProbeOk(true);
        if (git) {
          // git 分支是按目录缓存的：钩子只在 cwd 变化时才发，
          // 所以这里收到分支就直接替换（旧分支属于旧目录）。
          setStatus((s) => ({ ...s, branch: git }));
        }
        return true;
      });
      // 用户输入监听：一旦敲过字就永久放弃注入。
      const onData = term.onData(() => {
        typedRef.current = true;
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

  // ── 会话流程：重置 → 探测 → 注入 ──
  useEffect(() => {
    if (!enabled) {
      setState("off");
      return;
    }
    if (closed) return; // 断开：保留最后一次的状态，不再折腾
    reset();
    setState("pending");

    const probe = window.setTimeout(() => {
      if (typedRef.current) {
        setState("unsupported");
        return;
      }
      void invoke("ssh_input", { sessionId, data: `${PROBE_CMD}\n` }).catch(() =>
        setState("unsupported"),
      );
    }, PROBE_DELAY_MS);
    const giveUp = window.setTimeout(() => {
      setState((s) => (s === "pending" ? "unsupported" : s));
    }, PROBE_DELAY_MS + PROBE_TIMEOUT_MS);

    return () => {
      clearTimeout(probe);
      clearTimeout(giveUp);
    };
  }, [sessionId, enabled, closed, reset]);

  // 探针确认是 bash/zsh 之后才发钩子。这是防止往 fish/csh 里塞 bash 语法的关键闸门。
  useEffect(() => {
    if (!probeOk) return;
    const inject = window.setTimeout(() => {
      if (typedRef.current) return;
      void invoke("ssh_input", { sessionId, data: `${HOOK_CMD}\n` }).catch(() => {
        setState("unsupported");
      });
    }, 60);
    // 钩子挂上后要等**下一条提示符**才会跑。用户不动的话状态栏会一直停在 pending，
    // 所以补一个空回车让 shell 重绘一次提示符。此刻用户还没敲过字，空回车完全无害。
    const kick = window.setTimeout(() => {
      if (typedRef.current) return;
      void invoke("ssh_input", { sessionId, data: "\n" }).catch(() => {});
    }, 60 + KICK_DELAY_MS);
    return () => {
      clearTimeout(inject);
      clearTimeout(kick);
    };
  }, [probeOk, sessionId]);

  return { status, state };
}
