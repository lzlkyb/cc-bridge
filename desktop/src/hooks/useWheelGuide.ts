import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { attachTuiScrollbar, attachShiftWheel, type WheelOwner } from "../lib/terminalScroll";
import { loadTuiScrollSpeed } from "../lib/terminalScrollSpeed";
import {
  TUI_GUIDE_FLIP_THRESHOLD,
  loadGuideDismissed,
  markTuiSent,
  saveGuideDismissed,
  wasTuiSent,
} from "../lib/terminalTuiGuide";

/** 引导条三态：hidden=不显示；open=引导条展开（10s 倒计时）；collapsed=收起为状态栏「!」小徽章。 */
export type TuiGuideState = "hidden" | "open" | "collapsed";

/** 救急面板的初始步骤：info=滚轮救急说明；confirm=发送前确认（引导条「一键切换」直达）。 */
export type WheelPopStep = "info" | "confirm";

interface Params {
  sessionId: string;
  closed: boolean;
  termRef: RefObject<Terminal | null>;
  containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * 滚轮归属 + 一键 fullscreen 引导（设计稿《终端滚轮归属徽章与一键fullscreen》）。
 *
 * 职责：
 * 1. 挂载 TUI 虚拟滚动条 + Shift+滚轮本地滚动（原 SshTerminal 的挂载 effect 迁入，
 *    SshTerminal 在 300 行棘轮线上，挂载逻辑随 owner 状态整体下沉到本 hook）；
 * 2. 从 `attachTuiScrollbar` 的 onOwnerChange 收四态信号：驱动状态栏徽章（owner）、
 *    翻转计数（flips）、翻转 ≥2 次弹引导条（guide）；
 * 3. 救急面板开关（popoverOpen/popStep）：⚠ 徽章走 info 步，引导条直达 confirm 步。
 *
 * 断开（closed）时徽章与引导由消费方按 closed 隐藏；引导触发条件里也直接排除。
 * 「不再提示」「已发送」落在 lib/terminalTuiGuide.ts（localStorage，不进备份）。
 */
export function useWheelGuide({ sessionId, closed, termRef, containerRef }: Params) {
  const [owner, setOwner] = useState<WheelOwner>("local");
  const [flips, setFlips] = useState(0);
  const [guide, setGuide] = useState<TuiGuideState>("hidden");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popStep, setPopStep] = useState<WheelPopStep>("info");
  const flipsRef = useRef(0);
  const prevOwnerRef = useRef<WheelOwner>("local");
  // closed / sessionId 用 ref 承接：挂载 effect 只跑一次，闭包要总读到最新值。
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // 终端实例由 useSshTerminalSession 创建（其 effect 先于本 effect 运行），只需挂一次。
  useEffect(() => {
    const term = termRef.current;
    const container = containerRef.current;
    if (!term || !container) return;
    // Shift+滚轮强制滚本地 scrollback（业界惯例）：合成 wheel 不带 shiftKey，与转发路径互不干扰。
    attachShiftWheel(term);
    const offTui = attachTuiScrollbar(term, container, {
      // getter 而不是值：设置页改速度热生效，不必重挂（重挂会丢拖动位置）。
      speed: loadTuiScrollSpeed,
      onOwnerChange: (next) => {
        setOwner(next);
        if (next === prevOwnerRef.current) return; // 挂载首次回值若与缺省相同，不计翻转
        prevOwnerRef.current = next;
        flipsRef.current += 1;
        setFlips(flipsRef.current);
        // 归属切换 ≥ 阈值 → 弹引导条。触发瞬间再查 dismissed/sent（用户可能刚点过）。
        if (
          flipsRef.current >= TUI_GUIDE_FLIP_THRESHOLD &&
          !closedRef.current &&
          !loadGuideDismissed() &&
          !wasTuiSent(sessionIdRef.current)
        ) {
          setGuide((g) => (g === "hidden" ? "open" : g)); // 已收起为「!」徽章的不抢回来
        }
      },
    });
    return () => offTui();
    // termRef/containerRef 稳定；sessionId/closed 经 ref 读取；重连 = 组件重挂（翻转计数随之归零）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    owner,
    flips,
    guide,
    popoverOpen,
    popStep,
    /** ⚠ 死滚轮徽章：打开救急面板（info 步）。 */
    openPopover: () => {
      setPopStep("info");
      setPopoverOpen(true);
    },
    /** 引导条「一键切换 fullscreen」：直达发送确认（confirm 步）。 */
    openSendConfirm: () => {
      setPopStep("confirm");
      setPopoverOpen(true);
    },
    closePopover: () => setPopoverOpen(false),
    /** 引导条 10s 倒计时到点收起为「!」小徽章，不抢焦点。 */
    collapseGuide: () => setGuide("collapsed"),
    /** 「!」小徽章点击：重新展开引导条（倒计时重走）。 */
    expandGuide: () => setGuide("open"),
    /** 「不再提示」：永久压掉翻转引导条（⚠ 死滚轮徽章不受影响）。 */
    dismissForever: () => {
      saveGuideDismissed();
      setGuide("hidden");
    },
    /** 发送成功：记录 sentAt（同会话不再弹引导）并关面板。 */
    markSent: () => {
      markTuiSent(sessionId);
      setGuide("hidden");
      setPopoverOpen(false);
    },
  };
}
