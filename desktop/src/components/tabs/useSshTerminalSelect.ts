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
import { createSelectionCache } from "../../lib/terminalSelectionCache";
import {
  cancelPendingRelease,
  releaseSelectHoldNow,
  releaseSelectHoldSoon,
  setSelectHold,
} from "../../lib/terminalInputHold";
import { attachSelectWheelGuard } from "../../lib/terminalScroll";
import { forceSelectAt, isSynthMouse, replayMouseUp } from "../../lib/terminalSelectGesture";

/** 拖拽超过这个像素数才算「拖选」，以下当普通点击（不影响 TUI 定位光标）。 */
const DRAG_THRESHOLD = 4;

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
  /** 选择态镜像（手动选择模式 / 按住 Shift / 拖拽中，任一为真）。仅供观察，不参与滚轮判定。 */
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
  // 复制按钮读 term.getSelection() 恒为空。开启后本 hook 对每次起手都补一枚带强制修饰键的
  // mousedown 起本地选区（见 lib/terminalSelectGesture.ts）——**不改本地鼠标协议**。
  const [selectMode, setSelectMode] = useState(false);
  // Shift 自动选择：按住 Shift 期间临时关鼠标报告、松开恢复。
  const [shiftActive, setShiftActive] = useState(false);
  // 拖拽即选：按住左键移动超阈值时临时进入选择态，用于标题栏徽标提示。
  const [dragSelecting, setDragSelecting] = useState(false);

  const shiftActiveRef = useRef(false);
  const selectActiveRef = useRef(false);
  /** 选择模式的状态镜像：capture 级的 mousedown 处理器要读到最新值（闭包只挂一次）。 */
  const selectModeRef = useRef(false);
  selectModeRef.current = selectMode;
  // 选区缓存 + 复制去重（实现见 lib/terminalSelectionCache.ts）：远端 TUI（Claude Code）
  // 每帧重绘会冲空刚建立的本地选区，缓存是「复制选中」按钮的最后一道兜底。
  const cache = useRef(createSelectionCache()).current;
  const pointerDownRef = useRef(false);
  const downPosRef = useRef({ x: 0, y: 0 });
  const dragSelectRef = useRef(false);

  const toggleSelectMode = useCallback(() => setSelectMode((v) => !v), []);

  const hasSelection = useCallback(
    () => Boolean(termRef.current?.getSelection() || cache.read()),
    [termRef, cache],
  );

  const copySelection = useCallback(() => {
    // 优先读 live selection；被 TUI 重绘冲空时回退到缓存的最近非空选区。
    const live = termRef.current?.getSelection() ?? "";
    const sel = live || cache.read();
    if (!sel) {
      toast("未选中文字：请先拖选，或点「复制整屏」", "error");
      return;
    }
    cache.write(sel, (ok) => toast(ok ? "已复制选中文字" : "复制失败", ok ? "success" : "error"));
  }, [termRef, cache]);

  const attach = useCallback(
    (term: Terminal, container: HTMLElement) => {
      // 起手按下：先记指针状态（拖拽阈值判定要用）。
      const onPointerDown = (e: PointerEvent) => {
        pointerDownRef.current = true;
        downPosRef.current = { x: e.clientX, y: e.clientY };
      };
      container.addEventListener("pointerdown", onPointerDown, true);

      // 起手就带 Shift（或开着选择模式）：立刻闭输入闸 + 强制起本地选区。
      // 🔴 **capture** 阶段：xterm 的鼠标监听在子元素上，capture 先于它执行，闸门先闭合，
      // 这一按不会被编码成鼠标报告发给远端；而这里不 stopPropagation，xterm 仍要拿到它起选区。
      const onDown = (e: Event) => {
        if (isSynthMouse(e)) return; // 本模块合成的 mousedown（见 forceSelectAt）不再进一次手势
        const ev = e as MouseEvent;
        if (!ev.shiftKey && !selectModeRef.current) return;
        pointerDownRef.current = true;
        downPosRef.current = { x: ev.clientX, y: ev.clientY };
        if (ev.shiftKey) {
          shiftActiveRef.current = true;
          setShiftActive(true);
        }
        selectActiveRef.current = true;
        cancelPendingRelease(term); // 上一次手势的延时开闸可能还没跑，先撤掉
        setSelectHold(term, true);
        forceSelectAt(term, ev.clientX, ev.clientY);
      };
      container.addEventListener("mousedown", onDown, true);

      // 滚轮守卫：只做「Shift+滚轮 → 本地历史」与「输入闸漏松手」的兜底自检。
      // 🔴 它**不再**按选择态吞滚轮（第六轮改动）：吞的收益是「选字时内容不动」，代价是
      // 选择态一旦泄漏就整片滚不动（2026-10-16 报障）。详见 attachSelectWheelGuard 头注。
      const detachWheelGuard = attachSelectWheelGuard(container, () => termRef.current);

      // 拖拽即选择：按住左键移动超过阈值即自动进选择态（松手自动复制），纯点击不移动
      // 仍当普通点击、不影响 TUI 定位光标；window 级监听，拖出容器也持续收 move/up。
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
        // 🔴 顺序要紧：先补一枚 mouseup 收尾远端**已经收到**的那次按下（裸拖前 4px 里真实
        // mousedown 已被发出去，见 replayMouseUp），再闭闸——闭闸后报告会被 disableStdin
        // 拦在 triggerDataEvent 门口，就再也补不出去了。补发的报告会触发 xterm 的
        // onUserInput → clearSelection，所以必须早于 forceSelectAt（此刻还没有选区要保）。
        // 🔴 用**按下点**坐标补，不能用当前指针位置：远端收到的 mousedown 报告就是按下点，
        // 若抬起点已移动 4px+，远端会把它读成一次拖拽而不是点击。
        replayMouseUp(term, downPosRef.current.x, downPosRef.current.y);
        cancelPendingRelease(term);
        // 闭输入闸：此后 mousemove 不会再被编码成鼠标报告灌进 TUI（否则远端也在拖选一份、
        // 两个选区打架）。再按**拖拽起点**补一枚带强制修饰键的 mousedown 起本地选区——
        // xterm 的选区只能由 mousedown 启动，而真实那枚没带修饰键（判据见 forceSelectAt）。
        setSelectHold(term, true);
        forceSelectAt(term, downPosRef.current.x, downPosRef.current.y);
      };
      window.addEventListener("pointermove", onPointerMove);

      // 松手收尾：选择态期间抬起即写入剪贴板；空选区静默跳过（普通点击不触发）。
      const copyOnRelease = () => {
        pointerDownRef.current = false;
        if (!selectActiveRef.current) return;
        const t = termRef.current;
        if (!t) return;
        const live = t.getSelection() ?? "";
        const sel = live || cache.read();
        dragSelectRef.current = false;
        setDragSelecting(false);
        // 松手后只剩「手动选择模式」和「还按着 Shift」两种持续态。
        selectActiveRef.current = selectModeRef.current || shiftActiveRef.current;
        // 🔴 开闸必须**延后一拍**（releaseSelectHoldSoon）：xterm 把鼠标报告当**用户输入**发
        // （triggerMouseEvent → triggerDataEvent(report, true)），立刻开闸会让紧随 pointerup
        // 的 mouseup 报告一路走到 SelectionService 的 onUserInput → clearSelection()，
        // 用户看到的就是「一松手选区自己没了、来不及复制」。延后一拍把它拦在闸内。
        releaseSelectHoldSoon(t);
        if (!sel) return;
        // 去重只跳过重复写剪贴板（同一次松手可能触发多个 pointerup）；状态退出照常执行。
        if (cache.claim()) {
          // 成功也给一条轻提示：拖选即复制是**无按钮**的自动行为，不给反馈用户无从知道
          // 剪贴板里已经有东西（2026-10-16 报障）。去重窗口已保证不会刷屏。
          cache.write(sel, (ok, n) => toast(ok ? `已复制 ${n} 字` : "复制失败", ok ? "success" : "error"));
        }
      };
      // 🔴 capture 阶段：xterm 的视口与鼠标服务会对指针事件做捕获/短路，冒泡监听有时
      // 收不到 pointerup → 退出收尾不跑 → 滚轮卡在 dead（2026-10-16 用户报障：松手后
      // 滚不动、点终端外面才恢复）；capture 阶段必达，下游 stopPropagation 拦不住。
      window.addEventListener("pointerup", copyOnRelease, true);

      // 兜底出口：拖到窗口外松手 / 系统抢走指针 / 切窗口（Shift 的 keyup 会丢在别的窗口）时
      // 不会有 pointerup——闸与三个状态都必须另有一条复位路径，否则键盘一直哑、守卫一直
      // 以为还在选字（那正是「滚轮彻底滚不动」的成因，2026-10-16 报障）。
      const releaseHold = () => {
        pointerDownRef.current = false;
        dragSelectRef.current = false;
        shiftActiveRef.current = false;
        selectActiveRef.current = false;
        setShiftActive(false);
        setDragSelecting(false);
        releaseSelectHoldNow(term);
      };
      window.addEventListener("pointercancel", releaseHold);
      window.addEventListener("blur", releaseHold);

      // Shift 自动选择：xterm v6 下「Shift 原生选择 fallback」无效（画布文本不可选），
      // 故手动用转义序列实现；只响应聚焦的终端会话，多会话并存时互不误触。
      const onKeyDownShift = (e: KeyboardEvent) => {
        if (e.key !== "Shift" || e.repeat) return;
        if (!focusedRef.current) return;
        if (shiftActiveRef.current) return;
        shiftActiveRef.current = true;
        setShiftActive(true);
        // 🔴 中途按 Shift：指针已按下且未进选择态时立即补建选区——拖到一半想复制
        // 不再失败（此前只在 mousedown 时检测 shiftKey，先拖后按 Shift 无效）。
        if (pointerDownRef.current && !selectActiveRef.current) {
          selectActiveRef.current = true;
          // 裸按后中途按 Shift：xterm 已经把那枚 mousedown 发给了远端，先补 mouseup 收尾
          // （必须在闭闸前），否则远端会永远停在「按着左键」。
          replayMouseUp(term, downPosRef.current.x, downPosRef.current.y);
          cancelPendingRelease(term);
          setSelectHold(term, true);
          forceSelectAt(term, downPosRef.current.x, downPosRef.current.y);
        }
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
      const offSel = term.onSelectionChange(() => cache.remember(term.getSelection()));

      return () => {
        container.removeEventListener("mousedown", onDown, true);
        container.removeEventListener("pointerdown", onPointerDown, true);
        detachWheelGuard();
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", copyOnRelease, true);
        window.removeEventListener("pointercancel", releaseHold);
        window.removeEventListener("blur", releaseHold);
        window.removeEventListener("keydown", onKeyDownShift);
        window.removeEventListener("keyup", onKeyUpShift);
        offSel.dispose();
        // 卸载时松开输入闸：终端还在（跨重连保留）但手势监听没了，闸门留在闭合态
        // 就再也没人来开。松开是幂等的，代价为零。
        releaseSelectHoldNow(term);
      };
    },
    [termRef, focusedRef, dragSelectEnabledRef, cache],
  );

  // 选择态（手动选择模式 / 按住 Shift）开关：只做状态记账，**不再动本地鼠标报告**——
  // 选择期间的数据旁路由 terminalInputHold 的输入闸负责（在手势起止处开关），
  // 于是本地协议状态永远等于远端意图，滚轮归属不会因为选字而翻成 dead。
  useEffect(() => {
    // 🔴 拖拽临时态必须一起参与：本 effect 只依赖这两个 state，拖拽期间它们不变，可一旦
    // 别处触发重跑就会把正在进行的拖拽态抹掉（手势判据随之错位）。
    selectActiveRef.current = selectMode || shiftActive || dragSelectRef.current;
    const term = termRef.current;
    if (term && !selectActiveRef.current) releaseSelectHoldNow(term);
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
