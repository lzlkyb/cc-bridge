import type { Terminal } from "@xterm/xterm";

/**
 * TUI 态虚拟滚动条（终端滚动条 × Claude Code 等 fullscreen 程序）。
 *
 * 问题：fullscreen 渲染器把对话画在**备用屏**，本地 scrollback 是空的——
 * 原生滚动条没有东西可滚（拖了 0 字节发给 TUI），观感即「滚的是屏幕，不是内容」。
 * 滚轮本身没问题：xterm 会把 wheel 转成 SGR 鼠标报告，TUI 自己滚对话。
 *
 * 方案（设计稿《终端滚动条TUI滚动方案设计稿》）：
 * - 备用屏 + 鼠标跟踪激活时，在终端右缘注入**自绘虚拟滚动条**（覆盖层）；
 * - 拖动增量 Δ 行 → 合成 WheelEvent（deltaMode=LINE，1 行 = 1 次）→ xterm 转 SGR 转发；
 * - 拖到顶/底（越过虚拟边界）→ 发 Ctrl+Home / Ctrl+End 让 TUI 跳到最早/最新；
 * - 松手停在中间就停住，不回弹。
 *
 * 🔴 为什么不是「给 xterm 注入 spacer」：xterm 6 的 Viewport 重写为 VS Code 式
 * SmoothScrollableElement，每帧渲染都会用 `buffer.lines.length` 重设 scrollHeight
 * （备用屏下 = rows，即无滚动量），注入的高度立刻被冲掉。自绘覆盖层完全绕开它。
 *
 * 🔴 为什么转发 wheel 而不是方向键：Claude Code 把 ↑/↓ 当「输入框历史导航」
 * （GitHub issue #66601）；wheel→SGR 路径已由 headless Edge 探针实证：
 * deltaMode=LINE 的合成事件 1:1 产生 SGR 报告（\x1b[<64/65;…M），退出备用屏后 0 条。
 *
 * 检测信号（零轮询）：
 * - 备用屏切换：`term.buffer.onBufferChange`；
 * - 鼠标跟踪开关：xterm 给终端根元素加/摘 `enable-mouse-events` class，用
 *   MutationObserver 监听。两者都变才算 TUI 态（vim 无鼠标时不画，滚轮走 xterm 原生路径）。
 *
 * WHY 纯函数单独导出：拖动换算/边界判定是本方案最容易错的部分，抽成纯函数配 vitest。
 * WHY 接线放 lib 而不是 hook：`useSshTerminalSession` 在体量棘轮基线上（一行不能加），
 * 由 SshTerminal.tsx 挂载本函数。
 */

/** 虚拟总行数。TUI 不上报内容长度，这是纯启发式的可拖行程。 */
export const TUI_VIRTUAL_TOTAL = 500;
/** thumb 最小像素高度，避免 rows/TOTAL 比例把 thumb 压没。 */
export const TUI_THUMB_MIN_PX = 24;
/** 边界跳转触发后，要往回拖多少行才重新武装（防止顶死连发）。 */
export const TUI_EDGE_REARM_LINES = 8;

/**
 * TUI 滚动条激活判定：备用屏 + 鼠标跟踪（xterm 的 enable-mouse-events class）。
 * 纯函数便于单测；接线层负责喂这两个信号。
 */
export function isTuiScrollActive(bufferType: string, mouseEventsClass: boolean): boolean {
  return bufferType === "alternate" && mouseEventsClass;
}

/**
 * thumb 几何。pos ∈ [0, TUI_VIRTUAL_TOTAL]（0=顶=最早，TOTAL=底=最新）。
 * trackPx：滚动条轨道高度；rows：终端行数（thumb 高度 ∝ 视口占比）。
 */
export function thumbMetrics(
  pos: number,
  total: number,
  rows: number,
  trackPx: number,
): { topPx: number; heightPx: number } {
  const heightPx = Math.max(TUI_THUMB_MIN_PX, Math.min(trackPx, (trackPx * rows) / total));
  const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, pos / total));
  const topPx = (trackPx - heightPx) * ratio;
  return { topPx, heightPx };
}

/** 把任意位置夹回 [0, total]。 */
export function clampPos(pos: number, total: number): number {
  return Math.min(total, Math.max(0, pos));
}

export interface DragPlan {
  /** 夹紧后的虚拟位置。 */
  target: number;
  /** 向上越过顶边界的行数（>0 表示用户还想往上）。 */
  overflowUp: number;
  /** 向下越过底边界的行数。 */
  overflowDown: number;
}

/**
 * 拖动换算：从 startPos 向上拖 deltaLinesUp 行（向下拖为负），返回夹紧目标与边界溢出。
 * 边界命令（Ctrl+Home/End）由接线层结合 re-arm 状态决定是否真的发。
 *
 * 🔴 target 必须量化为整数行：wheel 转发是行级语义（1 次 = 1 行，见探针结论），
 * 若保留浮点，「记录的位置」与「实际发送的整数行」会漂移，拖动越多偏得越远。
 */
export function planDrag(startPos: number, deltaLinesUp: number, total: number): DragPlan {
  const raw = startPos - deltaLinesUp;
  return {
    target: clampPos(Math.round(raw), total),
    overflowUp: Math.max(0, -raw),
    overflowDown: Math.max(0, raw - total),
  };
}

/** 从 fromPos 滚到 toPos 需要的 wheel 次数（上/下）。 */
export function wheelCounts(fromPos: number, toPos: number): { up: number; down: number } {
  const delta = toPos - fromPos;
  return delta < 0 ? { up: Math.round(-delta), down: 0 } : { up: 0, down: Math.round(delta) };
}

/** 边界跳转的转义序列（xterm 编码：修饰参数 5 = Ctrl）。 */
export const TUI_EDGE_SEQ = {
  /** Ctrl+Home：跳到最早。 */
  home: "\x1b[1;5H",
  /** Ctrl+End：跳到最新（回底部）。 */
  end: "\x1b[1;5F",
} as const;

export interface TuiScrollbarOptions {
  /** 激活态变化（进入/退出 TUI 态）时回调，供状态栏徽标使用。 */
  onActiveChange?: (active: boolean) => void;
  /**
   * 拖动速度倍率 getter（1 = 1px 物理位移对应 1 行）。
   * 🔴 getter 而不是值：设置页热切换速度时不必拆掉重挂滚动条（重挂会丢当前位置）。
   */
  speed?: () => number;
}

/**
 * 给已 open 的终端挂上 TUI 虚拟滚动条。返回 detach 函数（幂等）。
 * 只追加 DOM 与监听，不触碰 xterm 内部状态，与拖选复制（另一条事件源）天然互斥：
 * 转发 wheel 时鼠标报告必然是开的（TUI 态），而拖选修复只在按住拖动时临时关它。
 */
export function attachTuiScrollbar(
  term: Terminal,
  container: HTMLElement,
  opts: TuiScrollbarOptions = {},
): () => void {
  const element = term.element;
  if (!element) return () => {};

  // ── DOM：右缘覆盖层 + thumb ──
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:absolute;right:2px;top:8px;bottom:8px;width:10px;z-index:15;display:none;" +
    "border-radius:6px;touch-action:none;cursor:default";
  const thumb = document.createElement("div");
  thumb.style.cssText =
    "position:absolute;left:2px;right:2px;border-radius:4px;background:rgba(140,148,168,.42);" +
    "cursor:grab;transition:background .15s";
  thumb.addEventListener("mouseenter", () => (thumb.style.background = "rgba(160,168,190,.7)"));
  thumb.addEventListener("mouseleave", () => (thumb.style.background = "rgba(140,148,168,.42)"));
  bar.appendChild(thumb);
  container.appendChild(bar);

  // 虚拟滚动位置（行）。进入 TUI 态重置为底部（最新）。
  let pos = TUI_VIRTUAL_TOTAL;
  // 边界跳转 re-arm：触发过 Ctrl+Home/End 后，须往回离开边界若干行才允许再触发。
  let topArmed = true;
  let bottomArmed = true;
  let active = false;

  const cellPx = (): number => {
    const screen = element.querySelector(".xterm-screen");
    const h = screen instanceof HTMLElement ? screen.getBoundingClientRect().height : 0;
    return h > 0 && term.rows > 0 ? h / term.rows : 16;
  };

  const renderThumb = () => {
    const trackPx = bar.clientHeight;
    if (trackPx <= 0) return;
    const { topPx, heightPx } = thumbMetrics(pos, TUI_VIRTUAL_TOTAL, term.rows, trackPx);
    thumb.style.top = `${topPx}px`;
    thumb.style.height = `${heightPx}px`;
  };

  /** 合成 wheel 事件：deltaMode=LINE，1 次 = 1 行（探针实证 1:1 转 SGR）。 */
  const sendWheel = (up: boolean) => {
    const screen = element.querySelector(".xterm-screen");
    const r = screen instanceof HTMLElement ? screen.getBoundingClientRect() : null;
    const cx = r ? r.left + r.width / 2 : 0;
    const cy = r ? r.top + r.height / 2 : 0;
    element.dispatchEvent(
      new WheelEvent("wheel", {
        deltaMode: 1 /* DOM_DELTA_LINE */,
        deltaY: up ? -1 : 1,
        clientX: cx,
        clientY: cy,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const sendEdge = (edge: "home" | "end") => {
    term.input(TUI_EDGE_SEQ[edge]);
  };

  /** 前向：把 pos 从 from 推到 to（夹紧），按需发 wheel 与边界命令。 */
  const forwardTo = (from: number, plan: DragPlan) => {
    const { up, down } = wheelCounts(from, plan.target);
    for (let i = 0; i < up; i++) sendWheel(true);
    for (let i = 0; i < down; i++) sendWheel(false);
    if (plan.overflowUp > 0 && topArmed) {
      sendEdge("home");
      topArmed = false;
    }
    if (plan.overflowDown > 0 && bottomArmed) {
      sendEdge("end");
      bottomArmed = false;
    }
    pos = plan.target;
    renderThumb();
  };

  // ── thumb 拖动（Pointer Events + capture，拖出滚动条也不断） ──
  let dragStartY = 0;
  let dragStartPos = 0;
  let lastSentPos = 0;
  const onThumbPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 刻意不 stopPropagation：让事件冒泡到容器的 grabFocus，拖完滚动条终端仍持有焦点。
    thumb.setPointerCapture(e.pointerId);
    dragStartY = e.clientY;
    dragStartPos = pos;
    lastSentPos = pos;
    thumb.style.cursor = "grabbing";
  };
  const onThumbPointerMove = (e: PointerEvent) => {
    if (!thumb.hasPointerCapture(e.pointerId)) return;
    // 速度倍率：每 1px 物理位移对应 speed 行（1=精细，3/5=长对话省手）。
    const deltaUp = ((dragStartY - e.clientY) / cellPx()) * (opts.speed?.() ?? 1);
    const plan = planDrag(dragStartPos, deltaUp, TUI_VIRTUAL_TOTAL);
    // re-arm：位置离开边界足够远后重新允许跳转。
    if (pos >= TUI_EDGE_REARM_LINES) topArmed = true;
    if (pos <= TUI_VIRTUAL_TOTAL - TUI_EDGE_REARM_LINES) bottomArmed = true;
    if (plan.target !== lastSentPos || plan.overflowUp > 0 || plan.overflowDown > 0) {
      forwardTo(lastSentPos, plan);
      lastSentPos = plan.target;
    }
  };
  const onThumbPointerUp = (e: PointerEvent) => {
    if (thumb.hasPointerCapture(e.pointerId)) thumb.releasePointerCapture(e.pointerId);
    thumb.style.cursor = "grab";
    // 松手停住：pos 就是当前值，不回弹。
  };
  thumb.addEventListener("pointerdown", onThumbPointerDown);
  thumb.addEventListener("pointermove", onThumbPointerMove);
  thumb.addEventListener("pointerup", onThumbPointerUp);
  thumb.addEventListener("pointercancel", onThumbPointerUp);

  // ── 轨道点击：朝点击方向翻一屏（不发边界命令，只夹紧） ──
  const onBarPointerDown = (e: PointerEvent) => {
    if (e.target !== bar || e.button !== 0) return;
    e.preventDefault();
    const barRect = bar.getBoundingClientRect();
    const thumbTop = thumb.getBoundingClientRect().top - barRect.top;
    // 点 thumb 上方 → 向上翻一屏（deltaLinesUp 为正 = 向上滚）。
    const above = e.clientY - barRect.top < thumbTop;
    const jump = Math.max(1, term.rows) * (above ? 1 : -1);
    forwardTo(pos, planDrag(pos, jump, TUI_VIRTUAL_TOTAL));
  };
  bar.addEventListener("pointerdown", onBarPointerDown);

  // ── 激活检测：buffer 切换 + enable-mouse-events class（零轮询） ──
  const recompute = () => {
    const next = isTuiScrollActive(
      term.buffer.active.type,
      element.classList.contains("enable-mouse-events"),
    );
    if (next === active) return;
    active = next;
    bar.style.display = active ? "block" : "none";
    if (active) {
      pos = TUI_VIRTUAL_TOTAL; // 进入 TUI 态：用户通常在最新消息处
      topArmed = true;
      bottomArmed = true;
      requestAnimationFrame(renderThumb);
    }
    opts.onActiveChange?.(active);
  };
  const offBuffer = term.buffer.onBufferChange(() => recompute());
  const mo = new MutationObserver(recompute);
  mo.observe(element, { attributes: true, attributeFilter: ["class"] });
  // 挂上时先算一次（attach 可能晚于进入 TUI 态，比如热重载/重连）。
  recompute();

  // 容器尺寸变化后 thumb 几何失效，重新画（只在激活时）。
  const ro = new ResizeObserver(() => {
    if (active) renderThumb();
  });
  ro.observe(container);

  return () => {
    offBuffer.dispose();
    mo.disconnect();
    ro.disconnect();
    thumb.removeEventListener("pointerdown", onThumbPointerDown);
    thumb.removeEventListener("pointermove", onThumbPointerMove);
    thumb.removeEventListener("pointerup", onThumbPointerUp);
    thumb.removeEventListener("pointercancel", onThumbPointerUp);
    bar.removeEventListener("pointerdown", onBarPointerDown);
    bar.remove();
    if (active) opts.onActiveChange?.(false);
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shift+滚轮强制滚本地 scrollback（TUI 态救急）
 *
 * WHY：wheel→SGR 转发只在备用屏+鼠标跟踪时把滚动交给 TUI，而 TUI 的对话流一旦
 * 滚走，想看「刚才那段输出」只能靠程序自己（Claude Code 的翻页各有各的键）。
 * Shift+滚轮强制滚**本地** scrollback 是 WezTerm/iTerm2/Ghostty 的通行惯例
 * （Zeron 项目把它写进验收标准）——备用屏下 scrollback 也可能有历史（进 TUI 前
 * 的输出都在），primary 屏（普通 shell）下更是直接生效。
 *
 * 实现：xterm 6 的 `attachCustomWheelEventHandler` 返回 false 即短路本次 wheel
 * （不转发 SGR、不滚动）。这里 Shift 按下 → 自己调 scrollLines 滚本地 → false。
 * TUI 滚动条拖动合成的事件不带 shiftKey，不受影响，两条路径互不干扰。
 */

/**
 * wheel 事件 → 本地滚动行数（带符号，正=向下）。
 * deltaMode 0（像素）：一格 ≈ ±100px，按 3 行/格换算并保留最小 1 行；
 * deltaMode 1（行）：1 格 = 1 行（与 SGR 转发路径同口径）。
 * 纯函数便于单测。
 */
export function shiftWheelLines(deltaY: number, deltaMode: number): number {
  if (deltaY === 0) return 0;
  if (deltaMode === 1) return Math.trunc(deltaY);
  // 像素模式：每 34px 记 1 行（WheelEvent 一格通常 100~120px ≈ 3 行），不足 1 行按 1 行算。
  const lines = Math.trunc(deltaY / 34);
  if (lines === 0) return deltaY > 0 ? 1 : -1;
  return lines;
}

/** 给终端挂上 Shift+滚轮本地滚动。返回卸载函数（xterm 只有一个 custom wheel 槽位，重复挂会顶掉前一个）。 */
export function attachShiftWheel(term: Terminal): void {
  term.attachCustomWheelEventHandler((e) => {
    if (!e.shiftKey) return true;
    const lines = shiftWheelLines(e.deltaY, e.deltaMode);
    if (lines !== 0) term.scrollLines(lines);
    return false;
  });
}
