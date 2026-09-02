import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  clampFontSize,
  loadFontSize,
  saveFontSize,
  FONT_SIZE_DEFAULT,
} from "../../lib/terminalFontSize";

/** 字号提示在屏幕中心停留多久。 */
const BADGE_MS = 800;

interface Args {
  termRef: RefObject<Terminal | null>;
  containerRef: RefObject<HTMLDivElement>;
  /** 字号变了必须重新 fit：行高/字宽变了，rows/cols 全变，还要同步给远端 PTY。 */
  doFit: () => void;
}

/**
 * Ctrl+滚轮 缩放终端字号。
 *
 * 监听写在容器上而不是 window：只有鼠标在终端上时才接管 Ctrl+滚轮，
 * 不干扰页面其它地方。`passive: false` 是必需的——不阻止默认行为的话，
 * WebView 会把 Ctrl+滚轮当成「缩放整个页面」，那会把整个 UI 搞乱。
 */
export function useTerminalFontSize({ termRef, containerRef, doFit }: Args) {
  const [fontSize, setFontSize] = useState<number>(() => loadFontSize());
  // 中心提示：null = 不显示。
  const [badge, setBadge] = useState<number | null>(null);
  const badgeTimer = useRef<number | undefined>(undefined);

  const bump = useCallback((delta: number) => {
    setFontSize((cur) => {
      const next = clampFontSize(cur + delta);
      if (next !== cur) saveFontSize(next);
      // 到边界了也要闪一下，否则用户不知道是“没生效”还是“到顶了”。
      setBadge(next);
      return next;
    });
  }, []);

  // 提示自动消失。单独一个 effect，避免在 setState 更新函数里做副作用（StrictMode 会双调）。
  useEffect(() => {
    if (badge === null) return;
    window.clearTimeout(badgeTimer.current);
    badgeTimer.current = window.setTimeout(() => setBadge(null), BADGE_MS);
    return () => window.clearTimeout(badgeTimer.current);
  }, [badge]);

  // 字号落到终端并重算尺寸。rAF 延一帧：xterm 改完 fontSize 后要先重新度量字体，
  // 同一帧里 fit 量到的还是旧行高。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    const id = requestAnimationFrame(doFit);
    return () => cancelAnimationFrame(id);
  }, [fontSize, termRef, doFit]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); // 否则 WebView 会缩放整页
      bump(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerRef, bump]);

  return { fontSize, badge, reset: () => bump(FONT_SIZE_DEFAULT - fontSize) };
}
