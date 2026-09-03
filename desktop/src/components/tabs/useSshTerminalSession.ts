import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
// 用 @xterm/* 而不是旧的 xterm / xterm-addon-fit：后者已被官方废弃
// （npm 上标着 "This package is now deprecated. Move to @xterm/xterm instead."），
// 永久冻结在 5.3.0，不再收任何修复。
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
// xterm 默认用 Unicode 6 的字符宽度表，部分中文标点 / emoji / 框线字符的宽度会算错，
// 结果就是 TUI（尤其是大量用框线 + emoji 的 Claude Code）排版串位。
// 这个插件依赖 `allowProposedApi: true`——下面已经开了。
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
// 终端里的链接用系统浏览器打开（项目里已有 opener 插件与 `opener:default` 权限）。
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke, listen } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { MOUSE_REPORT_OFF } from "./useSshTerminalSelect";
import { attachTerminalKeymap, type TerminalKeyActions } from "./terminalKeymap";
import { sshOutputEvent } from "../../lib/terminalEvents";
import { TERMINAL_FONT, TERMINAL_SCROLLBACK, terminalTheme } from "../../lib/terminalTheme";
import { loadFontSize } from "../../lib/terminalFontSize";
import { rowsToDrop } from "../../lib/terminalFit";
import { useTerminalPaste } from "./useTerminalPaste";
import type { Theme } from "../../lib/theme";
import type { SshOutput, SshClosed, SshConnectFailed } from "../../lib/types";

export type { PastePrompt } from "./useTerminalPaste";

interface Args {
  sessionId: string;
  /** 该终端当前是否可见（多标签切换时从 display:none → block，需重新 fit）。 */
  visible: boolean;
  /** 软件内全屏态：变化时容器尺寸剧变，需要重新 fit。 */
  fullscreen: boolean;
  mode: Theme;
  /** 会话已断开：禁掉键入，但终端保留（历史输出仍可滚可选可复制）。 */
  closed: boolean;
  /** 会话结束（远端断开 / 连接失败），带原因。 */
  onClosed: (reason: string) => void;
  containerRef: RefObject<HTMLDivElement>;
  termRef: MutableRefObject<Terminal | null>;
  focusedRef: MutableRefObject<boolean>;
  /** 选择态：ssh_output 每帧要读它决定要不要重关鼠标报告。 */
  selectActiveRef: MutableRefObject<boolean>;
  attachSelect: (term: Terminal, container: HTMLElement) => () => void;
  /** 复制选中（供 Ctrl+Shift+C 调用）。 */
  copySelection: () => void;
  /** 挂载 SearchAddon（供终端内搜索）。 */
  attachSearch: (term: Terminal) => () => void;
  /** 打开搜索框（供 Ctrl+Shift+F 调用）。 */
  openSearch: () => void;
}

/**
 * 单个 SSH 会话的 xterm 生命周期：创建/销毁、输入输出回路、尺寸同步、主题热切换、粘贴。
 * - onData → ssh_input（前端键入回传后端 PTY）
 * - listen(sshOutputEvent(sessionId)) → term.write（每会话一个事件名，不走全局广播）
 * - onResize → ssh_resize（窗口缩放跟手，vi/htop 不串列）
 */
export function useSshTerminalSession({
  sessionId,
  visible,
  fullscreen,
  mode,
  closed,
  onClosed,
  containerRef,
  termRef,
  focusedRef,
  selectActiveRef,
  attachSelect,
  copySelection,
  attachSearch,
  openSearch,
}: Args) {
  const fitRef = useRef<FitAddon | null>(null);
  // 以下回调/标志都用 ref 承接：它们每次渲染都可能是新引用，直接进创建 effect 依赖
  // 会导致每次父组件状态变化都 dispose/重建 xterm（丢历史输出）。
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const closedRef = useRef(closed);
  closedRef.current = closed;
  // 焦点状态：xterm 仅在隐藏 textarea 拿到焦点时 onData 才触发。未聚焦时在前台提示用户点击。
  const [focused, setFocused] = useState(false);
  // 最近一次 ssh_input 失败原因（前台可见，避免 .catch 静默吞错）。
  //
  // 这里刻意**不**再统计敲了多少字符：那个「已回传 N 字符」徽标是当初排查“能看不能输入”
  // 时加的调试件，诊断能力已被「点击终端以输入」与「输入失败」两个徽标覆盖；
  // 而它每敲一个字符就 setState 一次，等于每字符一次 React 重渲染。
  const [inputErr, setInputErr] = useState<string | null>(null);

  /**
   * 重算终端尺寸。只读 ref，故引用永久稳定。
   *
   * fit() 之后多一步实测、超了就回退行数，算法与理由见 `lib/terminalFit.ts`。
   */
  const doFit = useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    const box = containerRef.current;
    if (!fit || !term || !box) return;
    // 🔴 容器被隐藏时必须在 fit() **之前**就返回。
    // 切会话 / 切 app tab 都是用 display:none 隐藏（为保活 SSH 会话不卸载），此时容器尺寸为 0，
    // 而 FitAddon 算出的是 `Math.max(1, floor(0/行高)) = 1` 行 × 2 列——它会把这个尺寸
    // 通过 onResize 发给远端 PTY，远端 TUI 会照着 1x2 重排。ResizeObserver 在元素变为
    // display:none 时会以 0×0 触发，所以这条路径是真会走到的。
    if (box.clientHeight === 0 || box.clientWidth === 0) return;
    try {
      fit.fit();
    } catch {
      return; // 元素未挂载时 fit 会抛，忽略
    }
    const el = term.element;
    if (!el) return;
    // 量 `.xterm-screen`（正是 rows × 行高 那个盒子）与 `.xterm` 两者的较大值：
    // 前者直接对应渲染出来的字符网格，后者在不同 xterm 版本的 DOM 结构下未必跟随内容高。
    // 用 getBoundingClientRect 而不是 offsetHeight/clientHeight：后者是取整值，两个盒子各自
    // 舍入会凭空造出不足 1px 的“溢出”（缩放 125% 下很常见）。
    const screen = el.querySelector<HTMLElement>(".xterm-screen");
    const contentH = Math.max(
      el.getBoundingClientRect().height,
      screen?.getBoundingClientRect().height ?? 0,
    );
    const drop = rowsToDrop(contentH, box.getBoundingClientRect().height, term.rows);
    if (drop > 0) term.resize(term.cols, term.rows - drop);
  }, [containerRef, termRef]);

  // 粘贴（含多行确认框）单独成 hook，与终端生命周期无逻辑耦合。
  const { paste, pastePrompt } = useTerminalPaste({ sessionId, closedRef, termRef });

  // 供 xterm 按键钩子调用：那个钩子在创建 effect 里只注册一次，直接闭包会拿到陈旧引用。
  const keyActionsRef = useRef<TerminalKeyActions>({ paste, copy: copySelection, openSearch });
  keyActionsRef.current = { paste, copy: copySelection, openSearch };

  // 最近一次已经写进终端的输入错误（用于去重，见下面 onData）。
  const writtenInputErrRef = useRef<string | null>(null);
  // 上一次接好线的会话：null = 还没接过。用它分辨「首次挂载」与「重连」。
  const wiredSessionRef = useRef<string | null>(null);

  // 多标签切换：该终端从隐藏(display:none)变为可见时，容器重新获得尺寸，
  // 需要主动 fit 一次并把新尺寸告知后端，否则切回的终端会显示挤压/错位。
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      doFit();
      const term = termRef.current;
      if (!term) return;
      // 已断开的会话不抢焦点：此时键入无意义，焦点应当留给横幅上的「重新连接」。
      if (!closedRef.current) {
        try {
          term.textarea?.focus();
        } catch {
          /* textarea 未就绪 */
        }
        term.focus();
      }
      void invoke("ssh_resize", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
    }, 0);
    return () => clearTimeout(t);
  }, [visible, sessionId, doFit, termRef]);

  // 全屏切换会改变容器尺寸。ResizeObserver 会盖住这条，但再延一帧量一次更稳：
  // 切到全屏后布局、滚动条、字体度量未必在同一帧内全部稳定。
  useEffect(() => {
    const id = requestAnimationFrame(doFit);
    return () => cancelAnimationFrame(id);
  }, [fullscreen, doFit]);

  // 主题热切换：直接改 options.theme，**不重建终端**，历史输出与连接全保留。
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(mode);
  }, [mode, termRef]);

  // 断开后禁掉键入与光标闪烁：终端保留只是为了让历史输出可读可复制，
  // 再让它看起来像能敲东西就是误导（敲下去只会得到一堆「输入失败」）。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = closed;
    term.options.cursorBlink = !closed;
  }, [closed, termRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      // 初值直接取已保存的字号，避免先按默认值渲染一帧再跳到用户字号。
      fontSize: loadFontSize(),
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: TERMINAL_SCROLLBACK,
      theme: terminalTheme(modeRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Unicode 11 宽度表：必须在 open() 前加载并显式切到 "11"，光 loadAddon 不生效。
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // 链接可点。🔴 **只开 http/https**：终端输出是远端内容，把 `file://` 之类的 scheme
    // 盲目交给系统打开等于给远端一个本机执行面。
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (!/^https?:\/\//i.test(uri)) return;
        void openUrl(uri).catch((e) => toast(`打开链接失败：${e}`, "error"));
      }),
    );
    term.open(container);
    // WebGL 渲染：DOM 渲染在大量输出（tail -f / 构建日志）时会明显掉帧。
    // 🔴 必须处理上下文丢失：部分显卡/驱动（尤其虚拟机、远程桌面）会回收 WebGL context，
    // 不 dispose 就是一片白屏。dispose 后 xterm 自动退回 DOM 渲染，用户无感。
    // 必须在 open() 之后加载：它需要已挂载的 DOM 才能拿到 canvas 上下文。
    let webgl: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        webgl = null;
      });
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      // WebGL 不可用（虚拟机 / 禁用 GPU / 驱动太旧）：静默用 DOM 渲染，不打扰用户。
      webgl = null;
    }
    termRef.current = term;
    fitRef.current = fit;
    doFit();
    // 快捷键拦截（含为什么必须赶在 xterm 前面的完整理由）见 `terminalKeymap.ts`。
    attachTerminalKeymap(term, keyActionsRef);
    // 打开即聚焦隐藏 textarea：xterm 不在 open() 时自动聚焦，若不显式 focus，
    // onData 不触发、键入无法回传后端（输出正常但无法输入）。
    // 同步 focus 偶尔因“open 后初始布局未完成”落空，用 rAF + 短延时双保险。
    const grabFocus = () => {
      if (closedRef.current) return;
      try {
        term.textarea?.focus();
      } catch {
        /* 某些环境下 textarea 尚未就绪 */
      }
      term.focus();
    };
    grabFocus();
    requestAnimationFrame(grabFocus);
    setTimeout(grabFocus, 60);
    setTimeout(grabFocus, 200);
    // 让容器可获焦（tabindex=-1 不进 tab 序但可被程序/点击聚焦），并监听 focusin/focusout
    // 跟踪真实焦点——比只监听 textarea 的 focus/blur 更可靠。
    container.setAttribute("tabindex", "-1");
    const onFocusIn = () => {
      setFocused(true);
      focusedRef.current = true;
      grabFocus();
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (!next || !container.contains(next)) {
        setFocused(false);
        focusedRef.current = false;
      }
    };
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    // 点工具栏 / 切走再点回时夺回焦点（mousedown/pointerdown 比 click 更早，避免丢首个字符）。
    container.addEventListener("mousedown", grabFocus);
    container.addEventListener("pointerdown", grabFocus);
    // 选中与复制一整块（选择模式 / Shift / 拖拽即选 / 松手自动复制）交给 useSshTerminalSelect。
    const detachSelect = attachSelect(term, container);
    const detachSearch = attachSearch(term);

    // 容器尺寸变化 → 重新 fit（面板拉伸/窗口缩放/全屏切换）。
    // 用 rAF 合并同一帧内的多次回调（侧栏 300ms 宽度过渡会连发几十次），
    // 同时让浏览器先完成布局再量——doFit 里的实测依赖稳定的布局。
    let rafId = 0;
    const scheduleFit = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        doFit();
      });
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);
    // 拖到不同缩放的显示器时 devicePixelRatio 变化，xterm 的字体度量作废，必须重量一次。
    // 这种情况容器尺寸可能不变，ResizeObserver 不会触发，所以得单独监听。
    // matchMedia 只能监听“离开当前 dppx”，所以每次触发后要重新绑定到新值。
    let dprMq: MediaQueryList | null = null;
    const onDpr = () => {
      watchDpr();
      scheduleFit();
    };
    const watchDpr = () => {
      dprMq?.removeEventListener("change", onDpr);
      dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMq.addEventListener("change", onDpr);
    };
    watchDpr();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      dprMq?.removeEventListener("change", onDpr);
      detachSelect();
      detachSearch();
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      container.removeEventListener("mousedown", grabFocus);
      container.removeEventListener("pointerdown", grabFocus);
      ro.disconnect();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 🔴 依赖里**没有 sessionId**，这是故意的。重连会换一个 sessionId，但终端实例
    // 必须活下来：「断开后保留标签」的全部意义就是历史输出可读可选可复制，
    // 而以前 sessionId 一变就重建 xterm，等于点一下「重新连接」就把它们全清了。
    // 会话相关的接线（输入/输出/断开事件）在下面另一个 effect 里按 sessionId 重挂。
    // 其余依赖均为稳定引用（ref / useCallback）。
  }, [doFit, attachSelect, attachSearch, containerRef, termRef, focusedRef]);

  // ── 会话接线：按 sessionId 重挂，终端实例不动 ──
  //
  // 顺序保证：同一组件内的 effect 按声明顺序执行，上面那个先跑并填好 termRef。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // 重连（而非首次挂载）时在旧输出下面画一条分隔，否则新会话的提示符会
    // 直接接在断开前的输出后面，看不出中间断过。比对 sessionId 而不是用布尔量，
    // 是为了不被 StrictMode 的双调误判成重连。
    if (wiredSessionRef.current !== null && wiredSessionRef.current !== sessionId) {
      term.write("\r\n\x1b[36m[已重新连接]\x1b[0m\r\n");
      writtenInputErrRef.current = null;
    }
    wiredSessionRef.current = sessionId;

    // 连上后立即把真实尺寸告诉后端，避免初始 80x24 与面板不符。
    void invoke("ssh_resize", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});

    const offData = term.onData((data) => {
      void invoke("ssh_input", { sessionId, data })
        .then(() => {
          writtenInputErrRef.current = null;
          setInputErr(null);
        })
        .catch((e) => {
          const msg = String(e);
          setInputErr(msg);
          // 前台可见：onData 已触发但后端拒绝，红字提示便于定位（不再静默吞错）。
          // 🔴 同一个原因只写一次：总开关被关掉后每敲一个字符都会失败，
          // 不去重就是一敲一行红字，把最后那屏有用的输出直接刷没。
          if (writtenInputErrRef.current === msg) return;
          writtenInputErrRef.current = msg;
          term.write(`\x1b[31m\r\n[输入失败] ${msg}\x1b[0m`);
        });
    });
    const offResize = term.onResize(({ rows, cols }) => {
      void invoke("ssh_resize", { sessionId, rows, cols }).catch(() => {});
    });

    // 竞态防护：listen() 返回的 Promise 是异步 resolve 的。若组件在 resolve 之前就卸载，
    // cleanup 同步执行时 unlisten 还是 undefined，监听器会泄漏且永不注销。
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const track = (p: Promise<() => void>) =>
      void p.then((u) => {
        if (cancelled) u();
        else unlistens.push(u);
      });
    // 输出走**本会话专属**的事件名（不再是全局 `ssh_output` 广播），
    // 理由见 `lib/terminalEvents.ts`。sessionId 的判相当于空跑，但留着不亏。
    track(
      listen<SshOutput>(sshOutputEvent(sessionId), (p) => {
        if (p.sessionId !== sessionId) return;
        term.write(p.data);
        // 选择态期间，远端 TUI（如 Claude Code）会在重绘输出里重设鼠标报告（ESC[?1006h），
        // 导致本地 mouseTrackingMode 重新打开、拖选又被吃掉。故每帧输出后再关一次。
        if (selectActiveRef.current) term.write(MOUSE_REPORT_OFF);
      }),
    );
    // 🔴 断开/失败的原因不能只 `term.write` 完事——xterm 的 write 是攒到 rAF 才刷的，
    // 以前写完立刻卸载组件，那行字从来没有机会渲染，用户只看到标签凭空消失。
    // 现在交给 onClosed：会话保留为「已断开」态，原因同时上横幅和 toast。
    track(
      listen<SshClosed>("ssh_closed", (p) => {
        if (p.sessionId !== sessionId) return;
        term.write("\r\n\x1b[33m[连接已断开]\x1b[0m\r\n");
        onClosedRef.current("连接已断开");
      }),
    );
    // 连接早期失败：ssh 进程在宽限期内自行退出（主机/端口/认证错）。
    track(
      listen<SshConnectFailed>("ssh_connect_failed", (p) => {
        if (p.sessionId !== sessionId) return;
        term.write(`\r\n\x1b[31m[连接失败] ${p.reason}\x1b[0m\r\n`);
        onClosedRef.current(p.reason);
      }),
    );

    return () => {
      cancelled = true;
      offData.dispose();
      offResize.dispose();
      unlistens.forEach((u) => u());
    };
  }, [sessionId, termRef, selectActiveRef]);

  /** 整屏快照复制：从 xterm 缓冲区导出可视区域纯文本，不依赖选区（鼠标报告模式下也必成）。 */
  const copyScreen = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const start = buf.viewportY;
    const lines: string[] = [];
    for (let i = start; i < start + term.rows; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    const text = lines.join("\n").replace(/[ \t]+$/gm, "");
    if (!text.trim()) {
      toast("终端为空", "error");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => toast("已复制整屏", "success"))
      .catch(() => toast("复制失败", "error"));
  }, [termRef]);

  return { focused, inputErr, paste, copyScreen, pastePrompt, doFit };
}
