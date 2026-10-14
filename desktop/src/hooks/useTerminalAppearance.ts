import { useEffect, useState } from "react";
import { useThemeMode } from "./useThemeMode";
import {
  getTerminalMode,
  resolveTerminalMode,
  subscribeTerminalMode,
  type TerminalMode,
} from "../lib/terminalAppearance";
import { getFontStack, subscribeFontFamily } from "../lib/terminalFontFamily";
import type { Theme } from "../lib/theme";

/**
 * 订阅「终端明暗」这个**设置值**（三态：auto / dark / light）。
 *
 * 只有设置页与工具条菜单需要它——它们要显示「当前选的是哪一档」。
 * 终端自己要用解析后的 `Theme`，走下面的 `useTerminalThemeMode`。
 */
export function useTerminalThemeSetting(): TerminalMode {
  const [mode, setMode] = useState<TerminalMode>(getTerminalMode);
  useEffect(() => subscribeTerminalMode(() => setMode(getTerminalMode())), []);
  return mode;
}

/**
 * 终端实际要用的明暗（已把 `auto` 解析成当下的应用主题）。
 *
 * 🔴 **终端侧一切取明暗的地方都必须走这个 hook，不要直接用 `useThemeMode()`。**
 * 它是「应用浅色 + 终端深色」这个组合能不能成立的分水岭：终端的明暗消费点有六处
 * （xterm 调色板与对比度兜底、容器底色、状态栏皮肤、搜索高亮、OSC 11 应答、DEC 2031 上报），
 * 而它们在代码里吃的都是**同一个** `mode` 变量。
 *
 * 🔴 WHY 内部自己调 `useThemeMode()` 而不是让调用方传进来：
 * `SshTerminal.tsx` / `TerminalTab.tsx` 都已贴死体量门禁的 300 行上限，
 * 调用方多一行就破线；封装成一个零参数的 hook 才能做到「等行替换」。
 */
export function useTerminalThemeMode(): Theme {
  const appMode = useThemeMode();
  return resolveTerminalMode(useTerminalThemeSetting(), appMode);
}

/**
 * 订阅当前字体**栈**（直接喂给 xterm 的 `fontFamily`）。
 *
 * 返回栈而不是 id：调用方（xterm options / 状态栏样式）要的就是栈，
 * 转一次换一次出错机会。要显示「当前选的是哪套」请用 `lib/terminalFontFamily` 的
 * `getFontId()` 或直接比对 `FONT_STACKS[i].stack`。
 */
export function useTerminalFontStack(): string {
  const [stack, setStack] = useState<string>(getFontStack);
  useEffect(() => subscribeFontFamily(() => setStack(getFontStack())), []);
  return stack;
}
