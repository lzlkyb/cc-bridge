import { useEffect, useState } from "react";
import {
  getInjectEnabled,
  getPreset,
  subscribeInject,
  subscribePreset,
} from "../lib/terminalPreset";
import type { TerminalPreset } from "../lib/terminalTheme";

/**
 * 订阅当前终端预设（风格）。
 *
 * 与 `useThemeMode` 同一套路：组件挂载时先读一次现值，再订阅后续变更。
 * 先读一次是必要的——设置页可能在某个终端标签挂载**之前**就改过预设，
 * 光靠订阅会停在初始默认值上。
 */
export function useTerminalPreset(): TerminalPreset {
  const [preset, setPreset] = useState<TerminalPreset>(getPreset);
  useEffect(() => subscribePreset(() => setPreset(getPreset())), []);
  return preset;
}

/** 订阅「远端提示符钩子」开关（默认开）。关掉后不再向远端注入任何内容。 */
export function useTerminalInject(): boolean {
  const [on, setOn] = useState<boolean>(getInjectEnabled);
  useEffect(() => subscribeInject(() => setOn(getInjectEnabled())), []);
  return on;
}
