import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { toast } from "../ui/toast";

/**
 * 关掉本地 xterm 的鼠标报告，让拖选建立**本地选区**（而不是把鼠标事件发回远端 TUI）。
 *
 * 关键：这串转义必须用 `term.write()` 写给**本地 xterm 的输出流**。曾经错误地经 `ssh_input`
 * 发给远端 PTY(stdin)，xterm 从来不会解析它，而 xterm 的 mouseTrackingMode 只由「输出流」里的
 * 转义控制；Claude Code 在自己的输出里反复 ESC[?1006h，于是本地鼠标报告一直开着、
 * 拖选被吃掉、`term.getSelection()` 恒空 → 复制不出来。
 */
export const MOUSE_REPORT_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

/** 拖拽超过这个像素数才算「拖选」，以下当普通点击（不影响 TUI 定位光标）。 */
const DRAG_THRESHOLD = 4;
/**
 * 选区缓存的有效期。
 *
 * 🔴 没有这条线时缓存只增不减，是一个真实的误操作陷阱：按过一次 Ctrl+Shift+A
 * 全选之后，之后任何一次「复制选中」只要当下没有选区，都会静默回退到那份
 * **整个滚动历史（5000 行）**的缓存——用户以为复制的是刚拖选的内容。
 * 缓存的唯一用途是抵御 TUI 每帧重绘冲空 live selection，那是毫秒级的事，
 * 10 秒远远够用。
 */
const SELECTION_CACHE_TTL_MS = 10_000;
/** 同一次松手可能触发多个 pointerup（或 HMR 累积的多个监听闭包），窗口内只复制一次。 */
const COPY_DEDUP_MS = 500;

interface Args {
  termRef: RefObject<Terminal | null>;
  /** 本会话是否聚焦；window 级 Shift 监听靠它区分多会话，避免互相误触。 */
  focusedRef: MutableRefObject<boolean>;
  /** 设置项「拖拽即选」开关（用 ref 承接，使闭包总能读到最新值）。 */
  dragSelectEnabledRef: MutableRefObject<boolean>;
}

export interface SshTerminalSelect {
  /** 手动选择模式（工具栏按钮） */
  selectMode: boolean;
  /** 正按住 Shift */
  shiftActive: boolean;
  /** 本次拖拽临时进入了选择态 */
  dragSelecting: boolean;
  toggleSelectMode: () => void;
  /** 三条路径任一为真；ssh_output 每帧要读它决定要不要重关鼠标报告。 */
  selectActiveRef: MutableRefObject<boolean>;
  /** 复制选中（工具栏 / 右键菜单共用） */
  copySelection: () => void;
  /** 右键菜单判断「复制」是否可用 */
  hasSelection: () => boolean;
  /** 终端创建后调用，注册全部选区相关监听；返回注销函数。 */
  attach: (term: Terminal, container: HTMLElement) => () => void;
}

/**
 * SSH 终端的「选中与复制」一整块：选择模式 / 按住 Shift / 拖拽即选 / 松手自动复制。
 *
 * WHY 抽成 hook：这一块原本占 `SshTerminal.tsx` 将近一半篇幅，把文件顶到 621 行（规则 7 上限 300）。
 * 它与终端的连接/输入回路没有逻辑耦合，只需要一个 Terminal 实例和容器元素。
 */
export function useSshTerminalSelect({
  termRef,
  focusedRef,
  dragSelectEnabledRef,
}: Args): SshTerminalSelect {
  // 选择模式：TUI（如 Claude Code）开启鼠标报告模式后会吃掉鼠标拖选，xterm 选区建不起来、
  // 复制按钮读 term.getSelection() 恒为空。开启时把「关闭鼠标报告」写到本地 xterm。
  const [selectMode, setSelectMode] = useState(false);
  // Shift 自动选择：按住 Shift 期间临时关鼠标报告、松开恢复。
  const [shiftActive, setShiftActive] = useState(false);
  // 拖拽即选：按住左键移动超阈值时临时进入选择态，用于标题栏徽标提示。
  const [dragSelecting, setDragSelecting] = useState(false);

  const shiftActiveRef = useRef(false);
  const selectActiveRef = useRef(false);
  // 选区缓存：远端 TUI（Claude Code）每帧重绘会清空刚建立的本地选区，导致点「复制选中」时
  // term.getSelection() 已被冲空（而右键在 mouseup 瞬间复制故成功）。用 onSelectionChange 把最近
  // 一次非空选区缓存下来，按钮优先读缓存。带时间戳，过期即废（见 SELECTION_CACHE_TTL_MS）。
  const lastSelectionRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  /** 读缓存的选区；超期就当没有，并顺手丢掉（不让一份 5000 行的字符串常驻）。 */
  const cachedSelection = useCallback(() => {
    const c = lastSelectionRef.current;
    if (!c.text) return "";
    if (Date.now() - c.at > SELECTION_CACHE_TTL_MS) {
      lastSelectionRef.current = { text: "", at: 0 };
      return "";
    }
    return c.text;
  }, []);
  // 复制去重时间戳：跨所有松手监听实例共享（HMR 可能累积多个闭包）。
  const lastCopyAtRef = useRef(0);
  const pointerDownRef = useRef(false);
  const downPosRef = useRef({ x: 0, y: 0 });
  const dragSelectRef = useRef(false);

  const toggleSelectMode = useCallback(() => setSelectMode((v) => !v), []);

  const hasSelection = useCallback(
    () => Boolean(termRef.current?.getSelection() || cachedSelection()),
    [termRef, cachedSelection],
  );

  const copySelection = useCallback(() => {
    // 优先读 live selection；被 TUI 重绘冲空时回退到缓存的最近非空选区。
    const live = termRef.current?.getSelection() ?? "";
    const sel = live || cachedSelection();
    if (!sel) {
      toast("未选中文字：请先拖选，或点「复制整屏」", "error");
      return;
    }
    navigator.clipboard
      .writeText(sel)
      .then(() => toast("已复制选中文字", "success"))
      .catch(() => toast("复制失败", "error"));
  }, [termRef, cachedSelection]);

  const attach = useCallback(
    (term: Terminal, container: HTMLElement) => {
      // 终端重建（切会话 / HMR）后，把当前选择态重新落到新 term 上，
      // 否则 selectActiveRef 还是 true 但新终端的鼠标报告没关，拖选又会被吃掉。
      if (selectActiveRef.current) term.write(MOUSE_REPORT_OFF);

      // 起手按住 Shift 时：立即关本地鼠标报告并进入选择态，确保拖选建立本地选区——
      // 不依赖 onKeyDownShift 的聚焦门槛（终端未聚焦时 keydown 不触发，会导致 Shift 拖选失效）。
      const onDown = (e: Event) => {
        const ev = e as MouseEvent;
        pointerDownRef.current = true;
        downPosRef.current = { x: ev.clientX, y: ev.clientY };
        if (ev.shiftKey) {
          shiftActiveRef.current = true;
          setShiftActive(true);
          selectActiveRef.current = true;
          term.write(MOUSE_REPORT_OFF);
        }
      };
      container.addEventListener("mousedown", onDown);
      container.addEventListener("pointerdown", onDown);

      // 拖拽即选择：终端内按住左键并移动超过阈值即自动进选择态关本地鼠标报告，松手自动复制；
      // 纯点击（不移动）仍当普通点击，不影响 Claude Code 定位光标。
      // window 级监听：拖拽移出容器也能持续收到 move/up。
      const onPointerMove = (e: PointerEvent) => {
        // 开关关闭时拖拽不触发选择态——保持默认交互（拖拽不误伤 TUI 点击）；
        // 仍可按住 Shift 或点「选择模式」进入选择态。两条路径不受此开关影响。
        if (!dragSelectEnabledRef.current) return;
        if (!pointerDownRef.current) return;
        if (selectActiveRef.current) return; // 已进选择态不重复触发
        const dx = e.clientX - downPosRef.current.x;
        const dy = e.clientY - downPosRef.current.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        selectActiveRef.current = true;
        dragSelectRef.current = true;
        setDragSelecting(true);
        term.write(MOUSE_REPORT_OFF);
      };
      window.addEventListener("pointermove", onPointerMove);

      // 松手自动复制：选择态期间鼠标抬起即把选区写入剪贴板，无需再点「复制选中」。
      // 空选区静默跳过（普通点击 / 非选择态不触发），避免误提示。
      const copyOnRelease = () => {
        pointerDownRef.current = false;
        if (!selectActiveRef.current) return;
        const t = termRef.current;
        if (!t) return;
        const live = t.getSelection() ?? "";
        const sel = live || cachedSelection();
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
        if (now - lastCopyAtRef.current < COPY_DEDUP_MS) return;
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

      // Shift 自动选择：xterm v6 下「Shift 原生选择 fallback」无效（画布文本不可选），
      // 故手动用转义序列实现；只响应聚焦的终端会话，多会话并存时互不误触。
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

      // 选区缓存：选区一旦变化且非空即记入，抵御 TUI 持续重绘清空 live selection。
      const offSel = term.onSelectionChange(() => {
        const s = term.getSelection();
        if (s) lastSelectionRef.current = { text: s, at: Date.now() };
      });

      return () => {
        container.removeEventListener("mousedown", onDown);
        container.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", copyOnRelease);
        window.removeEventListener("keydown", onKeyDownShift);
        window.removeEventListener("keyup", onKeyUpShift);
        offSel.dispose();
      };
    },
    [termRef, focusedRef, dragSelectEnabledRef, cachedSelection],
  );

  // 选择态（手动选择模式 或 按住 Shift）开关：直接写到【本地 xterm】关闭鼠标报告。
  // 退出选择态时无需本地重开——远端 TUI 下次重绘会自行重设 ?1006h，bash 下本就不需鼠标报告。
  useEffect(() => {
    const term = termRef.current;
    const active = selectMode || shiftActive;
    selectActiveRef.current = active;
    if (term && active) term.write(MOUSE_REPORT_OFF);
  }, [selectMode, shiftActive, termRef]);

  return {
    selectMode,
    shiftActive,
    dragSelecting,
    toggleSelectMode,
    selectActiveRef,
    copySelection,
    hasSelection,
    attach,
  };
}
