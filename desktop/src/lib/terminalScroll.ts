import type { Terminal } from "@xterm/xterm";
import { isSelectHold, setSelectHold } from "./terminalInputHold";

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
 * 滚轮归属四态（设计稿《终端滚轮归属徽章与一键fullscreen》屏6）：
 * - local       主屏 × 无跟踪：滚本地 scrollback（xterm 默认，不出徽章）
 * - forward     备用屏 × 跟踪开：现有 TUI 态，虚拟滚动条 + wheel 转 SGR
 * - forwardMain 主屏 × 跟踪开：xterm 原生把滚轮发给程序（less 等），行为正确
 * - dead        备用屏 × 跟踪关：备用屏没有 scrollback、又没开转发 → 死滚轮
 */
export type WheelOwner = "local" | "forward" | "forwardMain" | "dead";

/**
 * 滚轮归属判定：纯函数便于单测；接线层负责喂这两个信号（零轮询）。
 */
export function wheelOwner(bufferType: string, mouseEventsClass: boolean): WheelOwner {
  if (bufferType === "alternate") return mouseEventsClass ? "forward" : "dead";
  return mouseEventsClass ? "forwardMain" : "local";
}

/**
 * TUI 滚动条激活判定（= wheelOwner 为 forward）。保留为独立导出：
 * 滚动条本体只关心「画不画」，归属徽章才关心四态。
 */
export function isTuiScrollActive(bufferType: string, mouseEventsClass: boolean): boolean {
  return wheelOwner(bufferType, mouseEventsClass) === "forward";
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

/** 屏幕矩形的几何子集（只取合成坐标要用的四项，便于单测喂假值）。 */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 合成 wheel 的触发坐标。
 *
 * 🔴 为什么不能一律用屏幕中心：Claude Code 的滚轮处理是**按坐标做命中测试**的——
 * `dispatchWheelEvent` 拿 (col,row) 反查命中的节点，再往上找带 onWheel 的祖先，
 * 找不到才退回聚焦元素。屏幕正中恰好是权限对话框 / 多选项列表的常规位置，于是
 * 「拖滚动条」变成「移动对话框选项」，甚至一路滚到 "No"（对应 TUI 内滚动视图的
 * wheelup/wheeldown 绑定只在滚动视图获得焦点时才生效）。
 *
 * 优先取真实指针位置（拖 thumb / 点轨道时的鼠标坐标）并夹进屏幕矩形：夹紧是必需的，
 * 落在屏幕外的坐标不会命中任何节点，等于把滚轮丢给未知的 fallback。
 * 没有指针可用时（程序化滚动）才回退屏幕中心。
 */
export function wheelPoint(
  rect: RectLike | null,
  pointer: { x: number; y: number } | null,
): { x: number; y: number } {
  if (!rect) return { x: pointer?.x ?? 0, y: pointer?.y ?? 0 };
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (!pointer) return { x: cx, y: cy };
  if (rect.width <= 2 || rect.height <= 2) return { x: cx, y: cy };
  return {
    x: Math.min(Math.max(pointer.x, rect.left + 1), rect.left + rect.width - 1),
    y: Math.min(Math.max(pointer.y, rect.top + 1), rect.top + rect.height - 1),
  };
}

const SYNTH_WHEEL_FLAG = "__ccbSynthWheel";

/** 给本模块合成的滚动条 wheel 打标记：选择态守卫据此放行，否则会把自己的事件吞掉。 */
export function markSynthWheel(e: WheelEvent): void {
  (e as WheelEvent & Record<string, unknown>)[SYNTH_WHEEL_FLAG] = true;
}

/** 是否为本模块合成的滚动条 wheel。 */
export function isSynthWheel(e: WheelEvent): boolean {
  return Boolean((e as WheelEvent & Record<string, unknown>)[SYNTH_WHEEL_FLAG]);
}

/** 边界跳转的转义序列（xterm 编码：修饰参数 5 = Ctrl）。 */
export const TUI_EDGE_SEQ = {
  /** Ctrl+Home：跳到最早。 */
  home: "\x1b[1;5H",
  /** Ctrl+End：跳到最新（回底部）。 */
  end: "\x1b[1;5F",
} as const;

export interface TuiScrollbarOptions {
  /**
   * 滚轮归属变化时回调（含挂载后首次计算）。四态枚举见 WheelOwner：
   * 状态栏徽章与翻转引导（hooks/useWheelGuide）都从这里拿信号。
   */
  onOwnerChange?: (owner: WheelOwner) => void;
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
  let active = false; // = owner 为 forward（滚动条可见）

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

  /**
   * 合成 wheel 事件：deltaMode=LINE，1 次 = 1 行（探针实证 1:1 转 SGR）。
   * pointer：真实指针坐标（拖 thumb / 点轨道时传入），见 wheelPoint 的命中测试说明。
   */
  const sendWheel = (up: boolean, pointer: { x: number; y: number } | null) => {
    const screen = element.querySelector(".xterm-screen");
    const r = screen instanceof HTMLElement ? screen.getBoundingClientRect() : null;
    const { x, y } = wheelPoint(r, pointer);
    const ev = new WheelEvent("wheel", {
      deltaMode: 1 /* DOM_DELTA_LINE */,
      deltaY: up ? -1 : 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    markSynthWheel(ev); // 选择态守卫要认出自产事件并放行
    element.dispatchEvent(ev);
  };

  const sendEdge = (edge: "home" | "end") => {
    term.input(TUI_EDGE_SEQ[edge]);
  };

  /** 前向：把 pos 从 from 推到 to（夹紧），按需发 wheel 与边界命令。 */
  const forwardTo = (from: number, plan: DragPlan, pointer: { x: number; y: number } | null = null) => {
    const { up, down } = wheelCounts(from, plan.target);
    for (let i = 0; i < up; i++) sendWheel(true, pointer);
    for (let i = 0; i < down; i++) sendWheel(false, pointer);
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
      forwardTo(lastSentPos, plan, { x: e.clientX, y: e.clientY });
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
    forwardTo(pos, planDrag(pos, jump, TUI_VIRTUAL_TOTAL), { x: e.clientX, y: e.clientY });
  };
  bar.addEventListener("pointerdown", onBarPointerDown);

  // ── 归属检测：buffer 切换 + enable-mouse-events class（零轮询） ──
  let owner: WheelOwner | null = null;
  const recompute = () => {
    const next = wheelOwner(
      term.buffer.active.type,
      element.classList.contains("enable-mouse-events"),
    );
    if (next === owner) return;
    owner = next;
    active = next === "forward";
    bar.style.display = active ? "block" : "none";
    if (active) {
      pos = TUI_VIRTUAL_TOTAL; // 进入 TUI 态：用户通常在最新消息处
      topArmed = true;
      bottomArmed = true;
      requestAnimationFrame(renderThumb);
    }
    opts.onOwnerChange?.(next);
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

/* ────────────────────────────────────────────────────────────────────────────
 * 终端滚轮守卫（容器捕获阶段，所有 wheel 都先过这里）
 *
 * 三档去向，按顺序判：
 * ① 自产事件（TUI 虚拟滚动条合成的 wheel）→ 放行，交给 xterm 原生协议路径；
 * ② Shift+滚轮 → 本地 scrollback（WezTerm/iTerm2 惯例），并**必须 preventDefault**：
 *    鼠标协议不在时 xterm 的 custom wheel handler 返回 false 之后它自己**不再**
 *    preventDefault（CoreBrowserTerminal 的 alt-buffer 分支 806-842 行直接 `return false`），
 *    事件会冒泡到外层可滚容器——用户看到的「滚动的是终端整个外层的内容」。
 * ③ 其余 → **一律放行**，交给 xterm 原生：协议开着时它按 SGR 转发给 TUI（正确路径）；
 *    主屏走本地 scrollback；只有「备用屏 × 协议没开」才是死窗，而那是远端程序自己
 *    没要鼠标事件（无 mouse 的 vim/less 等），由归属徽章提示用户，不归本守卫管。
 *
 * 🔴 **选择态不再吞滚轮**（2026-10-16 第六轮拍板，此前吞）。吞的两个理由如今都不成立：
 *    - 「选择时内容在选区底下滚走」——主流终端（WezTerm/iTerm2/Ghostty）选中后滚轮就是
 *      滚内容，xterm 自己也会在滚动时调整选区，属正常观感；
 *    - 「备用屏下落进方向键兜底被 Claude Code 当历史导航」——那只发生在协议**没开**时，
 *      而那时用户本来就滚不动，吞掉只会更滚不动。
 *    反过来，吞滚轮的代价是致命的：选择态一旦因异常路径（Shift 的 keyup 丢在别的窗口、
 *    HMR、指针取消）泄漏，**滚轮在整片终端区域彻底失效**（2026-10-16 报障）。放行之后
 *    这类故障在结构上消失——滚轮归属永远由协议状态决定，与选择态解耦。
 *
 * 实现：容器**捕获**阶段短路（仅 Shift 分支）。xterm 的 wheel 监听挂在终端根元素上，
 * 捕获先于它执行，一旦 stopPropagation，整条路径（SGR 转发 / 方向键兜底 / 本地滚动）
 * 都不会发生。
 *
 * ⚠️ 与其它容器级监听的顺序：Shift 分支在捕获阶段 stopPropagation，注册在它之后的
 * 容器级 wheel 监听（无论捕获还是冒泡）在按住 Shift 时都收不到事件。将来若把 Ctrl+滚轮
 * 缩放（useTerminalTypography，现挂冒泡阶段）改成容器捕获监听，要么放在本守卫之前
 * 注册，要么在此处显式放行 Ctrl/Meta，否则缩放会静默失效。
 */
export function attachSelectWheelGuard(
  container: HTMLElement,
  getTerm: () => Terminal | null,
): () => void {
  const swallow = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onWheel = (e: WheelEvent) => {
    if (isSynthWheel(e)) return;
    const term = getTerm();
    // Shift+滚轮 = 本地 scrollback（WezTerm/iTerm2 惯例），必须 preventDefault，
    // 成因见上面 ③（xterm 的 alt-buffer 分支返回 false 后不再 cancel，事件会滚外层页面）。
    if (e.shiftKey) {
      swallow(e);
      const lines = shiftWheelLines(e.deltaY, e.deltaMode);
      if (lines !== 0) term?.scrollLines(lines);
      return;
    }
    if (!term) return;
    // 兜底自检：选择手势收尾若被异常路径漏掉，输入闸会一直闭着（键盘鼠标全哑）。
    // 用户滚了一格就是「已经不在选择」的最强信号——顺手松开，下一次点击/输入即恢复。
    if (isSelectHold(term)) setSelectHold(term, false);
  };
  container.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => container.removeEventListener("wheel", onWheel, { capture: true });
}
