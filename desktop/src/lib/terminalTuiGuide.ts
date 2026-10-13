/**
 * 「一键 /tui fullscreen」引导的持久化（设计稿《终端滚轮归属徽章与一键fullscreen》屏4/屏7）。
 *
 * WHY localStorage 而不是后端 config：这两项是纯前端提示偏好，走 localStorage 零后端改动，
 * 与 `lib/terminalPreset.ts` 是同一套做法（同样不进备份/恢复——偏好丢失不影响功能）。
 *
 * 两个键：
 * - `cc-bridge.tui-guide-dismissed`：「不再提示」只压翻转引导条；⚠ 死滚轮徽章永不静音
 *   （它是功能性告警，不是引导）。
 * - `cc-bridge.tui-guide-sent`：已发送记录 `{ sessionId: ts }`。同一 SSH 会话发送过一次后
 *   不再弹引导（CC 重启进 fullscreen 后归属恒定，引导已无意义）。容量封顶防无限增长。
 */

const DISMISS_KEY = "cc-bridge.tui-guide-dismissed";
const SENT_KEY = "cc-bridge.tui-guide-sent";

/** 引导条触发阈值：本会话内滚轮归属切换次数（设计稿屏4）。 */
export const TUI_GUIDE_FLIP_THRESHOLD = 2;

/**
 * 发给远端的完整命令。🔴 结尾是 `\r`（回车提交），不是 `\n`——
 * Claude Code 把 `\n` 当输入框换行、`\r` 才是提交（与 Shift+Enter 的 LF 语义相反，见 SshTerminal 键盘处理注释）。
 */
export const TUI_FULLSCREEN_CMD = "/tui fullscreen\r";

export function loadGuideDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveGuideDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* 隐私模式 / 配额满：存不下就算了，引导条下次还会弹，不影响功能 */
  }
}

/** 已发送记录：sessionId → 时间戳。 */
type SentMap = Record<string, number>;

/** 封顶条数：按时间戳淘汰最旧的。会话数远小于此，仅为防御性上限。 */
const SENT_CAP = 30;

function readSentMap(): SentMap {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SentMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {}; // 坏 JSON（手改/旧版残留）：当作没发过，重来一次引导无害
  }
}

export function wasTuiSent(sessionId: string): boolean {
  return sessionId in readSentMap();
}

export function markTuiSent(sessionId: string): void {
  try {
    const map = readSentMap();
    // 时间戳取「不小于已有最大值 +1」：同一毫秒内连续 mark（测试/快速重连）时
    // 仍保持严格递增，容量淘汰按时间戳排序才是确定的（否则平局淘汰随机）。
    const prevMax = Object.values(map).reduce((m, v) => Math.max(m, v), 0);
    map[sessionId] = Math.max(Date.now(), prevMax + 1);
    const entries = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SENT_CAP);
    localStorage.setItem(SENT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 同 dismiss：存不下只影响「同会话不再弹」，无功能损害 */
  }
}
