import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../lib/tauri";
import {
  PROGRAM_STATUS_OSC,
  PROGRAM_STATUS_PROBE_REPLY,
  THEME_NOTIFY_MODE,
  blockedNotice,
  csiParamHasMode,
  isProgramStatusProbe,
  parseProgramStatus,
  themeNotifyReport,
  type ProgramStatus,
} from "../lib/terminalProgramStatus";
import type { Theme } from "../lib/theme";

interface Args {
  sessionId: string;
  /** 会话已断开：不再回写任何字节。 */
  closed: boolean;
  /** 当前亮/暗主题。变化时（若远端启用过 2031）自动上报。 */
  mode: Theme;
  termRef: MutableRefObject<Terminal | null>;
  /** 该会话是否正被用户看着（多标签）。用于决定 blocked 要不要弹系统通知。 */
  visible: boolean;
  /** 展示名（主机名），用于通知标题。 */
  label: string;
}

/**
 * 终端协议接缝：OSC 7501（程序状态）+ DEC 2031（主题变化通知）。
 *
 * WHY 单独成 hook 而不是塞进 useTerminalOsc：那边的整条时序是「注入钩子」，
 * 受设置里的注入开关控制，且**只在会话刚连上、用户还没输入时**跑一次。
 * 这两条协议完全不同——它们是**被动应答**：远端先开口（发探测 / 发 DECSET），
 * 我们才回一句。所以既不依赖注入开关，也不依赖时序，挂上就该一直有效。
 *
 * WHY 挂 `term.parser` 而不是拦出站数据流：xterm 的 parser API 自带跨 chunk 缓冲与
 * 转义序列定界（手写拦截要为「查询被切成两个 chunk」单独写状态机，`terminalOscQuery.ts`
 * 就是那么干的）。这里两条协议都只用注册回调就够。**前提已实证**（无头 Edge + 真实 xterm）：
 * - OSC 回调收到的 data 是 ident 之后、**不含首个分号**的内容（`ESC]7501;?` → `?`）；
 * - `registerCsiHandler` 是 push + **反向分发**（后注册先跑），返回 `false` 回退到 built-in、
 *   返回 `true` 截断它——所以只拦 2031 时，`?1000h` / `?1006h` 等仍照常生效。
 *
 * ⚠️ 回包一律走 `ssh_input`（与键入同方向）。远端程序读的是它自己的 stdin，
 * 往本地 xterm 写只会把字节显示在屏幕上。
 */
export function useTerminalProtocol({
  sessionId,
  closed,
  mode,
  termRef,
  visible,
  label,
}: Args): ProgramStatus | null {
  const [status, setStatus] = useState<ProgramStatus | null>(null);

  // 以下都是「handler 生命周期比 React 渲染长」的实时镜像：handler 只在终端实例上注册一次，
  // 闭包必须靠 ref 读到最新的 sessionId / 主题 / 可见性，否则重连后回包会打到旧会话。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const labelRef = useRef(label);
  labelRef.current = label;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const statusRef = useRef<ProgramStatus | null>(null);
  // 最近一次已处理的**原始上报**。规范要求程序在每条上报里重复它想保留的元数据
  // （一条上报完整替换原记录），所以远端会反复发一模一样的 payload；
  // 直接按 payload 去重，重复上报就不再触发整块终端面板的重渲染。
  const lastPayloadRef = useRef<string | null>(null);
  // 远端是否已启用 DEC 2031（Claude Code 发 `CSI ? 2031 h` 才会置真）。
  const themeNotifyRef = useRef(false);
  // 最近一次已上报的主题值：避免同一主题被重复发（2031h 与 mode 变化可能同时触发）。
  const lastReportedRef = useRef<boolean | null>(null);

  /** 回写一段字节给远端。连接已断则丢弃。 */
  const send = useCallback(
    (data: string) => {
      if (closedRef.current) return;
      void invoke("ssh_input", { sessionId: sessionIdRef.current, data }).catch(() => {});
    },
    [],
  );

  /** 按当前主题回 997。远端没启用 2031 时什么都不做。 */
  const reportTheme = useCallback(() => {
    if (!themeNotifyRef.current) return;
    const dark = modeRef.current === "dark";
    if (lastReportedRef.current === dark) return;
    lastReportedRef.current = dark;
    send(themeNotifyReport(dark));
  }, [send]);

  // 主题热切换 → 上报（远端启用过 2031 才有动作）。
  useEffect(() => {
    reportTheme();
  }, [mode, reportTheme]);

  // 换会话（含重连）时复位：新会话的 Claude Code 会自己重新启用 2031 并重新上报状态，
  // 不复位就会把 997 发给一个并不想要它的 shell，状态栏也会停在上一个会话的陈旧值上。
  useEffect(() => {
    themeNotifyRef.current = false;
    lastReportedRef.current = null;
    lastPayloadRef.current = null;
    statusRef.current = null;
    setStatus(null);
  }, [sessionId]);

  useEffect(() => {
    let raf = 0;
    let tries = 0;
    let dispose: (() => void) | null = null;

    const attach = () => {
      const term = termRef.current;
      // 终端实例由 useSshTerminalSession 的创建 effect 填好，那个 effect 声明在前，
      // 正常情况下此刻已就绪；重试只是不把「hook 声明顺序」当硬依赖。
      if (!term) {
        if (tries++ > 30) return;
        raf = requestAnimationFrame(attach);
        return;
      }

      const dOsc = term.parser.registerOscHandler(PROGRAM_STATUS_OSC, (data) => {
        // 探测：位置固定是「刚启动」，此刻还没任何人输入，回一句就够。
        if (isProgramStatusProbe(data)) {
          send(PROGRAM_STATUS_PROBE_REPLY);
          return true;
        }
        const p = parseProgramStatus(data);
        if (p !== null) {
          if (lastPayloadRef.current === data) return true; // 原样重复：不重渲染也不重复通知
          lastPayloadRef.current = data;
          const wasBlocked = statusRef.current?.state === "blocked";
          if (p.state === "clear") {
            statusRef.current = null;
            setStatus(null);
          } else {
            statusRef.current = p;
            setStatus(p);
            // 只在「进入 blocked」的那一次通知：blocked 的定义就是「不处理就永远卡住」，
            // 这正是用户走开了的场景；重复上报同一条记录不该反复弹。
            if (p.state === "blocked" && !wasBlocked) {
              const notice = blockedNotice(p, labelRef.current);
              // 用户正看着这个终端时不必弹：他马上就会看到。
              const watching = visibleRef.current && document.hasFocus();
              if (notice && !watching) {
                void invoke("notify_desktop", { title: notice.title, body: notice.body }).catch(() => {});
              }
            }
          }
        }
        return true; // 已消费：别让 xterm 再去渲染这条序列
      });

      // DECSET / DECRST 2031。非 2031 一律返回 false 回退给 xterm 的 built-in，
      // 否则会把 ?1000h（鼠标）/ ?1049h（备用屏）等全截胡，终端直接坏掉。
      const dH = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        if (!csiParamHasMode(params, THEME_NOTIFY_MODE)) return false;
        themeNotifyRef.current = true;
        reportTheme();
        return true;
      });
      const dL = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        if (!csiParamHasMode(params, THEME_NOTIFY_MODE)) return false;
        themeNotifyRef.current = false;
        // 一并清掉「上次已上报」的记忆：程序重新启用 2031（如界面重启）时，
        // 它需要重新知道当前明暗；留着旧值会让这一次启用静默无应答。
        lastReportedRef.current = null;
        return true;
      });

      dispose = () => {
        dOsc.dispose();
        dH.dispose();
        dL.dispose();
      };
    };
    attach();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      dispose?.();
    };
  }, [termRef, send, reportTheme]);

  return status;
}
