/**
 * OSC 52 剪贴板请求的解析与策略（**只开写半边**）。
 *
 * ## 为什么必须实现
 *
 * 全屏 TUI（Claude Code / vim / tmux / neovim）会接管鼠标（`?1000h`/`?1006h`），
 * 拖拽不再产生 xterm 原生选区 —— 此时**用户唯一的复制路径就是应用自己发 OSC 52**，
 * 请求终端代写系统剪贴板。已实证（本机 `claude.exe` 2.1.296）：
 *
 * - Claude Code 的复制就是发 OSC 52（`t_(CLIPBOARD, "c", base64)`）；
 * - 它**不会**因为「预测终端不支持」就不发 —— `predicted=` 只进日志、不进任何分支，
 *   且唯一「什么都不发」的分支要求本地有 xclip/wl-copy，而那条分支在 SSH 下恒为 false。
 *   → **SSH 场景下 OSC 52 是必然路径。**
 * - cc-bridge 此前**没有**注册 52，xterm.js 6 核心也不实现（需 addon 或自建 handler）
 *   → 请求被静默丢弃，界面显示「已复制 ✓」而系统剪贴板一个字没变。
 *
 * ## 为什么只开写半边（红线，改动前请三思）
 *
 * | 请求形态 | 含义 | 处理 |
 * |---|---|---|
 * | `c;<base64>` | 写剪贴板 | ✅ 允许 |
 * | `c;?` | **读**剪贴板 | ❌ 拒绝 —— 唯一的泄露面：远端进程可静默窃取你刚复制的密码/token |
 * | `c;`（空 payload） | 清空剪贴板 | ❌ 拒绝 —— 不该让远端程序静默抹掉用户内容 |
 * | 超大 payload | DoS 面 | ❌ 解码**前**拒绝，别在主线程解几 MB 的串 |
 *
 * 「写允许 / 读禁止」是行业默认值（Ghostty / Kitty / Warp / Terminal.app），
 * 不是我们擅自放宽。🔴 **不要把读半边「顺手补全」** —— 用户有 Ctrl+Shift+C 本地复制可用。
 */

/** base64 payload 的字符数上限（≈750KB 原始字节）。超过即拒绝，不做解码。 */
export const OSC52_MAX_PAYLOAD = 1_000_000;

export type Osc52Request =
  | { kind: "write"; text: string }
  | { kind: "reject"; reason: "malformed" | "read" | "empty" | "too-large" | "decode" };

/**
 * 解析 OSC 52 的 data（xterm 的 OSC 回调收到的是 ident 与首个 `;` **之后**的内容，
 * 即 `c;<base64>` / `c;?` / `c;` 这个整体）。
 *
 * targets 段（首个 `;` 之前）只做存在性校验、不区分 c/p/s：Windows 上它们落到同一块
 * 系统剪贴板，区分没有意义；而 `0-7`（cut buffer）同属「写入」语义。
 */
export function parseOsc52(data: string): Osc52Request {
  const sep = data.indexOf(";");
  if (sep === -1) return { kind: "reject", reason: "malformed" };
  const payload = data.slice(sep + 1);
  if (payload === "?") return { kind: "reject", reason: "read" };
  if (payload === "") return { kind: "reject", reason: "empty" };
  if (payload.length > OSC52_MAX_PAYLOAD) return { kind: "reject", reason: "too-large" };
  const text = decodeBase64Utf8(payload);
  if (text === null) return { kind: "reject", reason: "decode" };
  return { kind: "write", text };
}

/**
 * base64 → UTF-8 文本。非法 base64 返回 null（不抛）。
 *
 * ⚠️ 不能直接 `atob` 后当字符串用：`atob` 产出的是「每个字符一个字节」的二进制串，
 * 中文等多字节字符会被拆成一堆 U+0080~U+00FF，必须先经字节数组 + UTF-8 解码。
 */
function decodeBase64Utf8(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}
