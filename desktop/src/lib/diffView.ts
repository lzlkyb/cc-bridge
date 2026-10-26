import { useSyncExternalStore } from "react";

/**
 * Diff 视图偏好（优化轨道 A 定案 1）：单栏（unified） / 井排（side-by-side）。
 *
 * localStorage 全局记忆（跨 pane、跨重启），入口是 DiffBlock 顶栏的分段控件。
 * 默认 `u`（单栏）—— 与改动前一致，不给老用户换默认。
 *
 * 与 `chatTypography` 同构：模块级 store + `useSyncExternalStore`，
 * 不穿 props 链（工具卡可能在几十个 pane 里各有一份）。
 *
 * 🔴 刻意**不**把偏好塞进配置库/Rust 侧：这是纯展示偏好，丢了只影响观感，
 *    不值得为它引入一次 IPC 往返与 `save_config` 的落盘路径。
 */

export type DiffView = "u" | "s";

const KEY = "ccbridge_diff_view";

function read(): DiffView {
  try {
    return localStorage.getItem(KEY) === "s" ? "s" : "u";
  } catch {
    return "u";
  }
}

let current: DiffView = read();
const listeners = new Set<() => void>();

export function setDiffView(next: DiffView) {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 存不进只丢「跨重启记忆」，本窗口内仍即时生效
  }
  listeners.forEach((f) => f());
}

export function useDiffView(): DiffView {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export const DIFF_VIEW_LABEL: Record<DiffView, string> = {
  u: "单栏",
  s: "井排",
};
