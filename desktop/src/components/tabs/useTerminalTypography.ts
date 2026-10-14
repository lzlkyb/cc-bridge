import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  clampFontSize,
  loadFontSize,
  saveFontSize,
  subscribeFontSize,
  FONT_SIZE_DEFAULT,
} from "../../lib/terminalFontSize";
import { getFontStack, subscribeFontFamily } from "../../lib/terminalFontFamily";
import {
  isBundledFontsReady,
  subscribeBundledFonts,
} from "../../lib/bundledFonts";

/** 字号提示在屏幕中心停留多久。 */
const BADGE_MS = 800;

interface Args {
  termRef: RefObject<Terminal | null>;
  containerRef: RefObject<HTMLDivElement>;
  /**
   * 字号或**字体族**变了都要重新 fit。
   *
   * 🔴 字体那一路最容易被漏：字号改的是行高，字体改的是字**宽**——cols 也变。
   * 漏掉 fit 的表象不是「没生效」，而是远端 TUI 整体错位（边框错位、换行位置全歪），
   * 因为远端 PTY 以为的列数和本地实际渲染的对不上。
   */
  doFit: () => void;
}

/**
 * 终端的排版偏好：**字号**（Ctrl+滚轮 / 设置页步进）+ **字体族**（设置页 / 工具条选）。
 *
 * WHY 合并成一个 hook 而不是各管各的：两者共用同一个 `doFit` 收口——
 * 改任一项都要重新度量字体、重新适配尺寸、再把新行列同步给远端 PTY。
 * 拆开就得把这条约定抄两遍，漏一处就是远端 TUI 错位。
 *
 * 监听写在容器上而不是 window：只有鼠标在终端上时才接管 Ctrl+滚轮，
 * 不干扰页面其它地方。`passive: false` 是必需的——不阻止默认行为的话，
 * WebView 会把 Ctrl+滚轮当成「缩放整个页面」，那会把整个 UI 搞乱。
 */
export function useTerminalTypography({ termRef, containerRef, doFit }: Args) {
  const [fontSize, setFontSize] = useState<number>(() => loadFontSize());
  // 中心提示：null = 不显示。
  const [badge, setBadge] = useState<number | null>(null);
  const badgeTimer = useRef<number | undefined>(undefined);
  // 让稳定的 bump 读到当下值，不用把副作用写进 setState 的更新函数（StrictMode 会双调）。
  const sizeRef = useRef(fontSize);
  sizeRef.current = fontSize;

  // 字体族（栈）。与字号分开存：字号是「我看得清不清」，字体是「我喜欢哪种字形」，
  // 两者独立变化，但都走同一个 doFit 收口。
  const [fontFamily, setFontFamily] = useState<string>(getFontStack);

  // 订阅全局排版偏好：别处（另一个终端 / 设置页 / 工具条菜单）改了要跟着变。
  // 字号以前没这条线——键是全局的却只在当前终端生效，重启后其它终端才突然跳过去；
  // 字体同理，它决定每个字符多宽，所有开着的终端必须同时跟上。
  useEffect(() => {
    const offSize = subscribeFontSize(setFontSize);
    const offFont = subscribeFontFamily(() => setFontFamily(getFontStack()));
    return () => {
      offSize();
      offFont();
    };
  }, []);

  const bump = useCallback((delta: number) => {
    const cur = sizeRef.current;
    const next = clampFontSize(cur + delta);
    // 到边界了也要闪一下，否则用户不知道是“没生效”还是“到顶了”。
    // 只在鼠标所在的这个终端闪（广播只改字号、不带徽标）。
    setBadge(next);
    if (next === cur) return;
    setFontSize(next);
    saveFontSize(next); // 存盘 + 广播给其它终端
  }, []);

  // 提示自动消失。单独一个 effect，避免在 setState 更新函数里做副作用（StrictMode 会双调）。
  useEffect(() => {
    if (badge === null) return;
    window.clearTimeout(badgeTimer.current);
    badgeTimer.current = window.setTimeout(() => setBadge(null), BADGE_MS);
    return () => window.clearTimeout(badgeTimer.current);
  }, [badge]);

  // 字号与字体落到终端并重算尺寸 —— **合成一个 effect**：两者共用同一条收口，
  // 改任一项都要重新度量 + 重新 fit + 把新行列同步给远端。拆成两个就是要求两处
  // 都记得调 doFit，漏一处远端 TUI 就整体错位。
  // rAF 延一帧：xterm 改完这些选项后要先重新度量字体，同一帧里 fit 量到的还是旧行高。
  // 相等就不赋值：初值由 `useSshTerminalSession` 构造时给，挂载这一趟通常是空转，
  // 无谓地重写会让 xterm 重建字形纹理并闪一帧。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    if (term.options.fontFamily !== fontFamily) term.options.fontFamily = fontFamily;
    const id = requestAnimationFrame(doFit);
    return () => cancelAnimationFrame(id);
  }, [fontSize, fontFamily, termRef, doFit]);

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

  // 内置字体（JetBrains Mono / Fira Code）是 FontFace **异步**注册的：
  // 终端若在就绪前创建，xterm 会按回退字体度量。就绪广播到达时强制重赋一次
  // fontFamily 并 refit——值可能没变（上面的 apply effect 不会自己跑），所以这里
  // 直接落到终端：xterm 的 options setter 不做相等检查，同值赋值同样触发重新度量。
  // ⚠️ 就绪发生在「订阅之前、终端创建之后」的话广播已经错过——订阅时若已就绪
  // 就补一枪；就绪在终端创建之前发生时这一枪是空转（多度量一次，无害）。
  useEffect(() => {
    let raf = 0;
    const poke = () => {
      const term = termRef.current;
      if (!term) return;
      term.options.fontFamily = getFontStack();
      raf = requestAnimationFrame(doFit);
    };
    const off = subscribeBundledFonts(poke);
    if (isBundledFontsReady()) poke();
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [termRef, doFit]);

  return {
    fontSize,
    fontFamily,
    badge,
    reset: () => bump(FONT_SIZE_DEFAULT - fontSize),
  };
}
