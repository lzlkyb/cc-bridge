/**
 * 终端预设（风格）与「远端提示符钩子」开关的持久化。
 *
 * WHY 放 localStorage 而不是后端 config：
 * 后端 `config.rs` 里的终端设置（如 `ssh_drag_select_enabled`）要加字段就得改 Rust、
 * 重编译、过 CI。这两项是**纯前端观感偏好**，走 localStorage 可以做到零后端改动，
 * 与 `lib/uploadDir.ts`（上次上传目录）是同一套做法。
 *
 * 已知取舍：localStorage 不进 cc-bridge 的备份/恢复。换机器或清缓存后这两项会回到默认值
 * （预设回到 `indigo`、钩子开关回到开）——偏好丢失不影响功能，可接受。
 */
import type { TerminalPreset } from "./terminalTheme";

const PRESET_KEY = "cc-bridge.terminal-preset";
const INJECT_KEY = "cc-bridge.terminal-inject";

/** 默认预设。**必须与 `terminalTheme.ts` 里 2.7.x 时代的老配色一致**，老用户升级后观感不变。 */
export const DEFAULT_PRESET: TerminalPreset = "indigo";

/** 预设元信息：设置页的选择器直接遍历它，新增预设只改这一处。 */
export const PRESETS: ReadonlyArray<{
  id: TerminalPreset;
  name: string;
  desc: string;
}> = [
  { id: "indigo", name: "靖蓝 Indigo", desc: "与连接页同语言，indigo 主色 + cyan 辅助，玻璃渐变" },
  { id: "mono", name: "极简 Mono", desc: "无底色无图标，低饱和去霓虹，长时间看不累" },
  { id: "classic", name: "经典终端", desc: "深色为 CRT 磷光绿；亮色为暖纸感（绿压白底看不清，故另做）" },
  { id: "contrast", name: "高对比", desc: "纯黑/纯白底 + 高浓度 ANSI，弱光与投影环境" },
];

/** 窄化：localStorage 里可能是任意字符串（用户手改 / 旧版本残留），非法值一律回落默认。 */
function toPreset(raw: string | null): TerminalPreset {
  return PRESETS.some((p) => p.id === raw) ? (raw as TerminalPreset) : DEFAULT_PRESET;
}

/** 读取当前预设。localStorage 不可用时（隐私模式等）返回默认值，不抛。 */
export function loadPreset(): TerminalPreset {
  try {
    return toPreset(localStorage.getItem(PRESET_KEY));
  } catch {
    return DEFAULT_PRESET;
  }
}

export function savePreset(preset: TerminalPreset): void {
  try {
    localStorage.setItem(PRESET_KEY, preset);
  } catch {
    /* 隐私模式 / 配额满：偏好存不下就算了，不影响功能 */
  }
}

/**
 * 远端提示符钩子开关（默认开）。
 *
 * 关掉后状态栏只显示本地可算的段（连接名、会话时长），**不再向远端注入任何内容**。
 */
export function loadInjectEnabled(): boolean {
  try {
    return localStorage.getItem(INJECT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveInjectEnabled(on: boolean): void {
  try {
    localStorage.setItem(INJECT_KEY, on ? "on" : "off");
  } catch {
    /* 同上 */
  }
}

/* ------------------------------------------------------------------ *
 * 模块级小 store
 *
 * WHY 不各自 useState：终端可能同时开多个会话/标签，设置页一改，所有会话要同时生效。
 * `storage` 事件只在**其他**文档触发（同一窗口内改动不触发），所以得自己维护订阅。
 * ------------------------------------------------------------------ */

const presetListeners = new Set<() => void>();
const injectListeners = new Set<() => void>();
let presetCache = loadPreset();
let injectCache = loadInjectEnabled();

function emit(listeners: Set<() => void>): void {
  listeners.forEach((l) => l());
}

export function subscribePreset(l: () => void): () => void {
  presetListeners.add(l);
  return () => {
    presetListeners.delete(l);
  };
}

export function subscribeInject(l: () => void): () => void {
  injectListeners.add(l);
  return () => {
    injectListeners.delete(l);
  };
}

export function getPreset(): TerminalPreset {
  return presetCache;
}

export function setPreset(preset: TerminalPreset): void {
  if (presetCache === preset) return;
  presetCache = preset;
  savePreset(preset);
  emit(presetListeners);
}

export function getInjectEnabled(): boolean {
  return injectCache;
}

export function setInjectEnabled(on: boolean): void {
  if (injectCache === on) return;
  injectCache = on;
  saveInjectEnabled(on);
  emit(injectListeners);
}
