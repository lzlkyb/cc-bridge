/**
 * 终端「明暗」的持久化与解析。
 *
 * WHY 需要这个模块：终端的深浅此前**唯一**由应用主题决定（`useThemeMode()`），
 * 但「应用界面用浅色 + 终端用深色」是很常见的诉求。本文件把终端明暗拆成独立设置，
 * 三态里 `auto` 保持「跟随应用」= 老用户升级后观感一字不变。
 *
 * 🔴 解析出来的值必须喂给终端的**全部**明暗消费点，不能只喂调色板：
 * `terminalThemeOptions()`（主题 + 对比度兜底）、`TERMINAL_SURFACE`（容器底色）、
 * `STATUSBAR_SKINS`（状态栏皮肤）、搜索高亮、以及两个方向的远端协议——
 * OSC 11 查询应答（`useSshTerminalSession`）与 DEC 2031 主题上报（`useTerminalProtocol`）。
 * 只要在 `mode` 的定义处替换一次，这些点全部自动跟随（见 `useTerminalThemeMode`）。
 *
 * WHY 不走后端 config：与 `lib/terminalPreset.ts` 同一取舍——纯前端观感偏好，
 * 走 localStorage 可零 Rust 改动。代价同样是不进备份/恢复。
 */
import type { Theme } from "./theme";

/** 终端明暗三态。`auto` = 跟随应用主题（默认）。 */
export type TerminalMode = "auto" | "dark" | "light";

const KEY = "cc-bridge.terminal-mode";

/** 默认档位。**必须是 `auto`**：升级不得静默改变任何现有用户的观感。 */
export const DEFAULT_TERMINAL_MODE: TerminalMode = "auto";

/** 选择器（设置页 / 工具条菜单）直接遍历它，新增档位只改这一处。 */
export const TERMINAL_MODES: ReadonlyArray<{
  id: TerminalMode;
  name: string;
  desc: string;
}> = [
  { id: "auto", name: "跟随应用", desc: "终端深浅跟着应用界面走" },
  { id: "dark", name: "深色", desc: "终端固定深色，与应用无关" },
  { id: "light", name: "浅色", desc: "终端固定浅色，与应用无关" },
];

/** 窄化：localStorage 里可能是任意字符串（用户手改 / 旧版本残留），非法值一律回落默认。 */
export function toTerminalMode(raw: string | null): TerminalMode {
  return TERMINAL_MODES.some((m) => m.id === raw) ? (raw as TerminalMode) : DEFAULT_TERMINAL_MODE;
}

/**
 * 把「设置值 + 应用主题」解析成终端实际要用的明暗。
 *
 * 单独导出成纯函数是为了让三分支可单测；组件侧只经 `hooks/useTerminalAppearance`。
 */
export function resolveTerminalMode(setting: TerminalMode, appMode: Theme): Theme {
  return setting === "auto" ? appMode : setting;
}

/** localStorage 不可用时（隐私模式等）返回默认值，不抛。 */
export function loadTerminalMode(): TerminalMode {
  try {
    return toTerminalMode(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_TERMINAL_MODE;
  }
}

export function saveTerminalMode(mode: TerminalMode): boolean {
  try {
    localStorage.setItem(KEY, mode);
    return true;
  } catch {
    return false; // 当前会话仍应用，由调用方如实报告未持久化。
  }
}

/* ------------------------------------------------------------------ *
 * 模块级小 store
 *
 * WHY 不各自 useState：终端可能同时开多个会话/标签，设置页或工具条一改，
 * 所有会话要同时生效。`storage` 事件只在**其他**文档触发，所以得自己维护订阅。
 * ------------------------------------------------------------------ */

const listeners = new Set<() => void>();
let cache = loadTerminalMode();

export function subscribeTerminalMode(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getTerminalMode(): TerminalMode {
  return cache;
}

export function setTerminalMode(mode: TerminalMode): boolean {
  if (cache === mode) return saveTerminalMode(mode);
  cache = mode;
  const saved = saveTerminalMode(mode);
  listeners.forEach((l) => l());
  return saved;
}

/** 仅供测试：localStorage 被内存桩替换后必须重读，否则模块级缓存停在旧值上。 */
export function resetTerminalModeForTest(): void {
  cache = loadTerminalMode();
}
