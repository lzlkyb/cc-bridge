import { useEffect, useRef, useState } from "react";
// 用 @xterm/* 而不是旧的 xterm / xterm-addon-fit：后者已被官方废弃
// （npm 上标着 "This package is now deprecated. Move to @xterm/xterm instead."），
// 永久冻结在 5.3.0，不再收任何修复。
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "../../lib/tauri";
import { listen } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { Icon } from "../ui/icon";
import type { SshConnection, SshOutput, SshClosed, SshConnectFailed } from "../../lib/types";

/** 等宽 + 中文 fallback 字体栈：保证中文文件名/日志不乱码。 */
const FONT =
  'ui-monospace, SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

interface Props {
  sessionId: string;
  conn: SshConnection;
  onClose: () => void;
  /** 该终端当前是否可见（多标签切换时从 display:none → block，需重新 fit）。 */
  visible: boolean;
  /** 终端拖拽即选开关（设置项 ssh_drag_select_enabled）。开启时直接拖选即进选择态复制；
   * 关闭时拖拽不触发选择，必须按 Shift 或点「选择模式」。 */
  dragSelectEnabled: boolean;
}

/**
 * xterm.js 终端面板：渲染单个 SSH 会话。
 * - onData → ssh_input（前端键入回传后端 PTY）
 * - listen("ssh_output") → term.write（按 sessionId 路由该会话的输出）
 * - onResize → ssh_resize（窗口缩放跟手，vi/htop 不串列）
 * - TERM=xterm-256color + 中文字体（后端已设 LANG=C.UTF-8），中文 UTF-8 不乱码
 */
export function SshTerminal({ sessionId, conn, onClose, visible, dragSelectEnabled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // onClose 由父组件内联传入，每次渲染都是新引用。用 ref 承接，避免它进入
  // useEffect 依赖导致每次父组件状态变化都 dispose/重建 xterm（丢历史输出）。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // dragSelectEnabled 来自父组件 props（设置项），用 ref 承接，使 onPointerMove 闭包
  // 总能读到最新值，且不让它进入 effect 依赖导致 xterm 重建。
  const dragSelectEnabledRef = useRef(dragSelectEnabled);
  dragSelectEnabledRef.current = dragSelectEnabled;
  // 焦点状态：xterm 仅在隐藏 textarea 拿到焦点时 onData 才触发。未聚焦时在前台提示用户点击，
  // 也便于排查「能看不能输入」到底是焦点问题还是后端问题。
  const [focused, setFocused] = useState(false);
  // 诊断用：onData 触发次数 + 最近一次 ssh_input 失败原因（前台可见，避免 .catch 静默吞错）。
  // - keystrokes 不涨 → onData 没触发（焦点）
  // - keystrokes 涨但红字「输入失败」→ onData 触发、但 ssh_input 后端拒绝（看原因）
  // - keystrokes 涨且 shell 有回显 → 输入回路通了
  const [keystrokes, setKeystrokes] = useState(0);
  // 拖拽即选择：按住左键移动超阈值时临时进入选择态，用于标题栏徽标提示。
  const [dragSelecting, setDragSelecting] = useState(false);
  const [inputErr, setInputErr] = useState<string | null>(null);
  const keystrokesRef = useRef(0);
  // 选择模式：TUI（如 Claude Code）开启鼠标报告模式后会吃掉鼠标拖选，xterm 选区建不起来、
  // 复制按钮读 term.getSelection() 恒为空。开启时直接把「关闭鼠标报告」的转义写到本地 xterm
  // （term.write ESC[?...l），使 xterm 回到本地选区可自由拖选；ssh_output 每帧再关一次抵御远端重设。
  const [selectMode, setSelectMode] = useState(false);
  // Shift 自动选择模式：按住 Shift 期间临时关鼠标报告、松开恢复（与手动 selectMode 共用同一套开关）。
  const [shiftActive, setShiftActive] = useState(false);
  const shiftActiveRef = useRef(false);
  const focusedRef = useRef(false); // 与 focused 同步，供 window 键盘监听判断本会话是否聚焦
  // 是否处于选择态（手动选择模式 或 按住 Shift 任一为真）。为真时本地 xterm 关闭鼠标报告，
  // 使拖选建立本地选区（而非把鼠标事件发回远端 TUI）。供 ssh_output 监听每帧重关判定。
  const selectActiveRef = useRef(false);
  // 选区缓存：xterm v6 canvas 下，远端 TUI（Claude Code）每帧重绘会清空刚建立的本地选区，
  // 导致点「复制选中」时 term.getSelection() 已被冲空（而右键在 mouseup 瞬间复制故成功）。
  // 故用 onSelectionChange 把最近一次非空选区缓存下来，按钮优先读缓存，抵御重绘冲选区。
  const lastSelectionRef = useRef("");
  // 复制去重时间戳：跨所有松手监听实例共享（HMR 可能累积注册多个 copyOnRelease 闭包），
  // 500ms 内只复制一次，避免一次拖选松手弹出多条「已复制」提示。
  const lastCopyAtRef = useRef(0);
  // 拖拽即选择：记录指针按下状态/起点，以及本次是否由拖拽临时进入选择态（区别于手动选择模式 / 按住 Shift）。
  const pointerDownRef = useRef(false);
  const downPosRef = useRef({ x: 0, y: 0 });
  const dragSelectRef = useRef(false);

  // 多标签切换：该终端从隐藏(display:none)变为可见时，容器重新获得尺寸，
  // 需要主动 fit 一次并把新尺寸告知后端，否则切回的终端会显示挤压/错位。
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => {
        try {
          fitRef.current?.fit();
          const term = termRef.current;
          if (term) {
            try {
              term.textarea?.focus();
            } catch {
              /* textarea 未就绪 */
            }
            term.focus(); // 切回该终端时夺回焦点，免去手动点击
            void invoke("ssh_resize", {
              sessionId,
              rows: term.rows,
              cols: term.cols,
            }).catch(() => {});
          }
        } catch {
          /* 元素未挂载时忽略 */
        }
      }, 0);
      return () => clearTimeout(t);
    }
  }, [visible, sessionId]);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        // 配色对齐「SSH 终端侧边栏折叠」设计稿（方案 A mockup）：高饱和 ANSI 色 + 略提亮主文本，
        // 抵消 canvas 抗锯齿的软感，避免终端整体发灰发雾。背景沿用设计稿 #1e1e1e。
        background: "#1e1e1e",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#22c55e",
        yellow: "#dcdcaa",
        blue: "#60a5fa",
        magenta: "#c4b5fd",
        cyan: "#4ec9b0",
        white: "#e6e6e6",
        brightBlack: "#8a8a8a",
        brightRed: "#f44747",
        brightGreen: "#22c55e",
        brightYellow: "#dcdcaa",
        brightBlue: "#60a5fa",
        brightMagenta: "#c4b5fd",
        brightCyan: "#4ec9b0",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    // 打开即聚焦隐藏 textarea：xterm 不在 open() 时自动聚焦，若不显式 focus，
    // onData 不触发、键入无法回传后端（输出正常但无法输入）。
    // 同步 focus 偶尔因「open 后初始布局未完成」落空，用 rAF + 短延时双保险确保真正聚焦；
    // 同时直接 focus 底层 textarea（比 term.focus() 更稳，部分 WebView 下 term.focus() 不生效）。
    const grabFocus = () => {
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
    // 跟踪真实焦点——比只监听 textarea 的 focus/blur 更可靠（某些 WebView 下 textarea 事件不冒泡/不触发）。
    // 焦点一进容器就主动夺回 textarea 焦点，确保 onData 能触发。
    const container = containerRef.current;
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
    // 点工具栏 / 切走再点回时夺回焦点（mousedown/pointerdown 比 click 更早触发，避免丢首个字符）。
    // 起手按住 Shift 时：立即关本地鼠标报告并进入选择态，确保拖选建立本地选区——
    // 不依赖 onKeyDownShift 的焦点门槛（终端未聚焦时 keydown 不触发，会导致 Shift 拖选失效）。
    const focusOnMouseDown = (e: Event) => {
      grabFocus();
      const ev = e as MouseEvent;
      // 记录按下起点，供 onPointerMove 判定是否进入拖拽选择态。
      pointerDownRef.current = true;
      downPosRef.current = { x: ev.clientX, y: ev.clientY };
      if (ev.shiftKey) {
        shiftActiveRef.current = true;
        setShiftActive(true);
        selectActiveRef.current = true;
        term.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
      }
    };
    container.addEventListener("mousedown", focusOnMouseDown);
    container.addEventListener("pointerdown", focusOnMouseDown);
    // 拖拽即选择：终端内按住左键并移动超过阈值即自动进选择态关本地鼠标报告，松手自动复制；
    // 纯点击（不移动）仍当普通点击，不影响 Claude Code 定位光标。无需记 Shift / 点按钮。
    // window 级监听：拖拽移出容器也能持续收到 move/up（配合 copyOnRelease 的 window pointerup）。
    const DRAG_THRESHOLD = 4;
    const onPointerMove = (e: PointerEvent) => {
      // 开关关闭时拖拽不触发选择态——保持默认交互（拖拽不误伤 TUI 点击）；
      // 仍可按住 Shift 或点「选择模式」进入选择态复制。两条路径不受此开关影响。
      if (!dragSelectEnabledRef.current) return;
      if (!pointerDownRef.current) return;
      if (selectActiveRef.current) return; // 已进选择态（Shift / 选择模式 / 已拖拽）不重复触发
      const dx = e.clientX - downPosRef.current.x;
      const dy = e.clientY - downPosRef.current.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      selectActiveRef.current = true;
      dragSelectRef.current = true;
      setDragSelecting(true);
      term.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
    };
    window.addEventListener("pointermove", onPointerMove);
    // 松手自动复制：选择态期间（手动选择模式 或 按住 Shift 拖选），鼠标/指针抬起即把选区写入剪贴板，
    // 无需再点「复制选中」按钮。松手瞬间 live selection 仍有效；若被 TUI 重绘冲空则回退 onSelectionChange 缓存。
    // 空选区静默跳过（普通点击 / 非选择态不触发），避免误提示。
    const copyOnRelease = () => {
      pointerDownRef.current = false;
      if (!selectActiveRef.current) return;
      const term = termRef.current;
      if (!term) return;
      const live = term.getSelection() ?? "";
      const sel = live || lastSelectionRef.current;
      if (!sel) {
        // 空选区：拖拽临时选择态直接退出（不复制、不提示）；手动/Shift 选择态保留供后续操作。
        if (dragSelectRef.current) {
          selectActiveRef.current = false;
          dragSelectRef.current = false;
          setDragSelecting(false);
        }
        return;
      }
      const now = Date.now();
      // 去重：同一松手动作可能触发多个 pointerup（或 HMR 累积的多个监听闭包），
      // 500ms 内只复制一次，避免一次拖选弹出多条「已复制」提示。
      if (now - lastCopyAtRef.current < 500) return;
      lastCopyAtRef.current = now;
      navigator.clipboard
        .writeText(sel)
        .then(() => toast("已复制选中文字", "success"))
        .catch(() => toast("复制失败", "error"));
      // 拖拽临时选择：复制后退出选择态，恢复 TUI 鼠标（远端下次重绘自行重设 ?1006h）。
      if (dragSelectRef.current) {
        selectActiveRef.current = false;
        dragSelectRef.current = false;
        setDragSelecting(false);
      }
    };
    window.addEventListener("pointerup", copyOnRelease);
    // Shift 自动选择：按住 Shift 临时关鼠标报告（xterm 回到本地选区可拖选复制），松开恢复。
    // xterm v6 canvas 渲染下「Shift 原生选择 fallback」无效（canvas 文本不可选），故手动用转义序列实现；
    // 只响应聚焦的终端会话（focusedRef），多会话并存时互不误触。
    const onKeyDownShift = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || e.repeat) return;
      if (!focusedRef.current) return;
      if (shiftActiveRef.current) return;
      shiftActiveRef.current = true;
      setShiftActive(true);
    };
    const onKeyUpShift = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      if (!shiftActiveRef.current) return;
      shiftActiveRef.current = false;
      setShiftActive(false);
    };
    window.addEventListener("keydown", onKeyDownShift);
    window.addEventListener("keyup", onKeyUpShift);
    // 选区缓存：选区一旦变化且非空即记入 lastSelectionRef，供「复制选中」按钮读取，
    // 抵御 Claude Code 等 TUI 持续重绘清空 live selection（见 lastSelectionRef 注释）。
    const offSel = term.onSelectionChange(() => {
      const s = term.getSelection();
      if (s) lastSelectionRef.current = s;
    });

    // 连上后立即把真实尺寸告诉后端，避免初始 80x24 与面板不符。
    void invoke("ssh_resize", {
      sessionId,
      rows: term.rows,
      cols: term.cols,
    }).catch(() => {});

    const offData = term.onData((data) => {
      keystrokesRef.current += 1;
      setKeystrokes(keystrokesRef.current);
      void invoke("ssh_input", { sessionId, data })
        .then(() => setInputErr(null))
        .catch((e) => {
          const msg = String(e);
          setInputErr(msg);
          // 前台可见：onData 已触发但后端拒绝，红字提示便于定位（不再静默吞错）。
          term.write(`\x1b[31m\r\n[输入失败] ${msg}\x1b[0m`);
        });
    });
    const offResize = term.onResize(({ rows, cols }) => {
      void invoke("ssh_resize", { sessionId, rows, cols }).catch(() => {});
    });

    // 竞态防护：listen() 返回的 Promise 是异步 resolve 的。若组件在 resolve 之前
    // 就卸载（例如快速连/断、切 Tab 触发重建），cleanup 同步执行时 unlistenOut/
    // unlistenClosed 还是 undefined，监听器会泄漏且永不注销。
    // 用 cancelled 标志：卸载后置 true，Promise resolve 后若已取消立即注销；
    // 同时把已 resolve 的 unlisten 收进数组，cleanup 兜底注销（不论 resolve 先后）。
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    void listen<SshOutput>("ssh_output", (p) => {
      if (p.sessionId === sessionId) {
        term.write(p.data);
        // 选择态期间，远端 TUI（如 Claude Code）会在重绘输出里重设鼠标报告（ESC[?1006h），
        // 导致 xterm 本地 mouseTrackingMode 重新打开、拖选又被吃掉。故每帧输出后再关一次本地鼠标报告，
        // 保证拖选时刻 mouseTrackingMode=none → 选区可建、term.getSelection() 有内容。
        if (selectActiveRef.current) {
          term.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
        }
      }
    }).then((u) => {
      if (cancelled) u();
      else unlistens.push(u);
    });
    void listen<SshClosed>("ssh_closed", (p) => {
      if (p.sessionId === sessionId) {
        term.write("\r\n\x1b[33m[连接已断开]\x1b[0m\r\n");
        onCloseRef.current();
      }
    }).then((u) => {
      if (cancelled) u();
      else unlistens.push(u);
    });
    // 连接早期失败：ssh 进程在宽限期内自行退出（主机/端口/认证错）。
    // 立即红字提示并清 UI，避免「已连接黑屏」的静默失败。
    void listen<SshConnectFailed>("ssh_connect_failed", (p) => {
      if (p.sessionId === sessionId) {
        term.write(`\r\n\x1b[31m[连接失败] ${p.reason}\x1b[0m\r\n`);
        onCloseRef.current();
      }
    }).then((u) => {
      if (cancelled) u();
      else unlistens.push(u);
    });

    // 容器尺寸变化 → 重新 fit（面板拉伸/窗口缩放）。
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* fit 在元素未挂载时可能抛错，忽略 */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      offData.dispose();
      offResize.dispose();
      offSel.dispose();
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      unlistens.forEach((u) => u());
      ro.disconnect();
      container.removeEventListener("mousedown", focusOnMouseDown);
      container.removeEventListener("pointerdown", focusOnMouseDown);
      window.removeEventListener("pointerup", copyOnRelease);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDownShift);
      window.removeEventListener("keyup", onKeyUpShift);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  const handleCopy = () => {
    // 优先读 live selection；被 TUI 重绘冲空时回退到 onSelectionChange 缓存的最近非空选区。
    const live = termRef.current?.getSelection() ?? "";
    const sel = live || lastSelectionRef.current;
    if (!sel) {
      toast("未选中文字：请先拖选，或点「复制整屏」", "error");
      return;
    }
    navigator.clipboard
      .writeText(sel)
      .then(() => toast("已复制选中文字", "success"))
      .catch(() => toast("复制失败", "error"));
  };
  const handleClear = () => termRef.current?.clear();
  const handleDisconnect = () => {
    void invoke("ssh_disconnect", { sessionId })
      .then(() => onClose())
      .catch((e) => toast(`断开失败：${e}`, "error"));
  };
  // 选择模式开关（手动）：只切换状态，本地鼠标报告的关闭由下方协调 effect（兼顾 Shift 自动选择）统一处理。
  const toggleSelectMode = () => setSelectMode((v) => !v);
  // 选择态（手动选择模式 或 按住 Shift）开关：直接写到【本地 xterm】关闭鼠标报告，
  // 让拖选建立本地选区（而非把鼠标事件发回远端 TUI）。
  //
  // 关键：之前错误地经 ssh_input 把 ESC[?1006l 发给「远端 PTY(stdin)」，xterm 从不会解析它，
  // 而 xterm 的 mouseTrackingMode 只由「输出流」里的转义控制；Claude Code 在自己的输出里反复
  // ESC[?1006h，于是本地鼠标报告一直开着、拖选被吃掉、term.getSelection() 恒空 → 复制不出来。
  // 正确做法是 term.write(重置序列) 让本地 xterm 解析并关闭鼠标报告；ssh_output 监听每帧再关一次
  // （见上方 listen），抵御远端重设。退出选择态时无需本地重开——远端 TUI 下次重绘会自行重设 ?1006h，
  // bash 下本就不需鼠标报告。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const active = selectMode || shiftActive;
    selectActiveRef.current = active;
    if (active) {
      term.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
    }
  }, [selectMode, shiftActive, sessionId]);
  // 整屏快照复制：从 xterm 缓冲区直接导出可视区域纯文本，不依赖选区（鼠标报告模式下也必成）。
  const handleCopyScreen = () => {
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
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 标题栏：连接名 + 连接地址 + 已连接徽章 + 操作，分组用分隔线区隔 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="terminal" size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium">{conn.name || conn.host}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {conn.username}@{conn.host}:{conn.port}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          已连接
        </span>
        {(selectMode || shiftActive || dragSelecting) && (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
            {dragSelecting
              ? "拖选复制"
              : shiftActive && !selectMode
                ? "按住 Shift·拖选复制"
                : "选择模式·拖选复制"}
          </span>
        )}
        {inputErr ? (
          <span
            title={inputErr}
            className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            输入失败
          </span>
        ) : keystrokes > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
            已回传 {keystrokes} 字符
          </span>
        ) : (
          !focused && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              点击终端以输入
            </span>
          )
        )}
        <div className="ml-auto flex items-center gap-1 border-l border-border pl-2">
          <ButtonIcon title="复制选中" onClick={handleCopy}>
            <Icon name="copy" size={14} />
          </ButtonIcon>
          <ButtonIcon title="复制整屏" onClick={handleCopyScreen}>
            <Icon name="monitor" size={14} />
          </ButtonIcon>
          <ButtonIcon
            title={selectMode ? "退出选择模式（恢复鼠标报告）" : "选择模式（关鼠标报告以拖选复制）"}
            highlight={selectMode}
            onClick={toggleSelectMode}
          >
            <Icon name="sliders" size={14} />
          </ButtonIcon>
          <ButtonIcon title="清屏" onClick={handleClear}>
            <Icon name="refresh" size={14} />
          </ButtonIcon>
          <ButtonIcon title="断开" danger onClick={handleDisconnect}>
            <Icon name="power" size={14} />
          </ButtonIcon>
        </div>
      </div>
      {/* 终端画布 */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden bg-[#1e1e1e] p-2"
      />
    </div>
  );
}

function ButtonIcon({
  title,
  onClick,
  danger,
  highlight,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
        danger ? "hover:bg-destructive/10 hover:text-destructive" : ""
      } ${highlight ? "bg-primary/15 text-primary hover:bg-primary/20" : ""}`}
    >
      {children}
    </button>
  );
}
