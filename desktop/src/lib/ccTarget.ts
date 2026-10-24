/**
 * 起一轮时用哪个 claude 路径。
 *
 * ## 为什么需要这条判断
 *
 * 远端**必须**用绝对路径执行：真正跑起来的 bash 是非登录的（`base64 -d | bash`），
 * 拿不到 `~/.local/bin` 那份 PATH，直接写 `claude` 会「命令不存在」。
 * 而绝对路径只有 `cc_probe` 拿得到。
 *
 * ## 为什么不能只挑「有值就用」
 *
 * 探测结果属于**某一次目标**。用户从 A 机切到 B 机时，A 的路径若被沿用，
 * 远端会 `exec` 一个 B 机上不存在的文件 —— 报错是「No such file」，
 * 而用户看到的是「刚换了连接就起不来」。所以必须比对目标。
 *
 * ## 为什么本机也要带
 *
 * PATH 里可能有多份 claude（npm 全局 + 独立安装），探测到哪个就该跑哪个 ——
 * 否则「检测通过」和「实际执行」可能是两个版本，版本不一致的报错极难对上号。
 */
export function pickClaudePath(
  /** 调用方显式给的（目前 UI 不传，留给将来「手动指定路径」）。 */
  explicit: string | null | undefined,
  /** 最近一次探测结果 + 它属于哪个目标。 */
  probed: { connId: string | null; path: string } | null,
  /** 本次要跑的目标。 */
  connId: string | null,
): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  if (probed && probed.connId === connId && probed.path.trim()) return probed.path.trim();
  // 返回 null 而不是 "claude"：让 Rust 侧决定兜底值（它那边是 `unwrap_or("claude")`），
  // 前端再拼一次等于两处各写一份默认值。
  return null;
}
