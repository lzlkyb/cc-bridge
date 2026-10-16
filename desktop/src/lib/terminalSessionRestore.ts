/**
 * 终端会话恢复（方案 A：骨架恢复 + 手动重连，无自动连接行为）。
 *
 * 存的是「标签组快照」：每个主格标签的连接 id + 活动下标。重连**永远由用户点击发起**
 * ——不自动 ssh_connect：弱网/离线启动不会半死，也不背并发撞远端 rate limit 的失败链。
 *
 * WHY localStorage 而不是 Rust config：标签组是纯前端概念（会话表在 React state 里），
 * 走 localStorage 与终端预设/字号同模式，零 Rust 改动；连接本身（凭证、id）已在
 * Rust config 持久化，这里只存引用。
 */

const KEY = "cc-bridge.terminal-session-restore";
const VERSION = 1;

export interface RestoreSnapshot {
  v: number;
  /** 主格标签序列（按标签栏顺序），splitOnly 副格不存——分屏形状每次自己开。 */
  tabs: { connId: string }[];
  /** 活动标签在 tabs 里的下标；越界由恢复方夹紧。 */
  active: number;
}

export function loadRestoreSnapshot(): RestoreSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as RestoreSnapshot;
    if (snap?.v !== VERSION || !Array.isArray(snap.tabs)) return null;
    return snap;
  } catch {
    // 快照损坏就当没有：恢复是增强能力，不能反过来堵启动。
    return null;
  }
}

export function saveRestoreSnapshot(tabs: { connId: string }[], active: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, tabs, active }));
  } catch {
    /* localStorage 满/禁用：恢复功能静默降级 */
  }
}
