import type { IProgressState } from "@xterm/addon-progress";

/**
 * 标签页的「活动元信息」：由终端实例内部事件（OSC 标题 / OSC 9;4 进度 / BEL 铃）
 * 上报，存进 useSshSessions，供 TerminalTabsBar 展示。
 *
 * WHY 按 sessionId 存 Record 而不是扩 SshSessionRef：SshSessionRef 定义在
 * TerminalConnectionItem.tsx，是连接列表与标签栏共用的契约——加展示性字段会让
 * 连接列表侧跟着感知「标签栏才需要的东西」。Record 天然支持重连换 sessionId
 * （旧 key 由 closeTab / dropConnection 清理）。
 */
export interface TermTabMeta {
  /** 远端程序经 OSC 0/2 上报的标题（已净化），null = 未上报。 */
  title: string | null;
  /** OSC 9;4 进度（ConEmu 协议，addon-progress 解析），null = 无进度。 */
  progress: IProgressState | null;
  /** 最近一次 BEL 的时间戳，null = 无未读铃声。激活标签时被清零。 */
  bellAt: number | null;
}

export const EMPTY_TAB_META: TermTabMeta = { title: null, progress: null, bellAt: null };

/** 标题在标签上的最大字符数——超长的是路径/命令行，不是人眼要读的程序名。 */
const TITLE_MAX = 24;

/**
 * OSC 0/2 标题净化。
 *
 * 标题是**远端字符串直接进 UI**，两条底线：
 * 1. 控制字符与 ANSI 转义序列必须剥掉（恶意程序可借标题注入转义序列改写终端，
 *    即「标题诈骗」；退一步说至少也是乱码）；
 * 2. 截断 + 空标题回退 null（标签回显主机名）。
 * 注意：这里**不试图白名单程序名**——标题会被正常程序设成 "user@host: path"，
 * 一刀切白名单会把它们全部错杀。防诈骗靠「标题永远只作为主机名的**附加**段显示」，
 * 主机名不可被标题顶替。
 */
export function sanitizeTitle(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- 要剥的就是 ANSI 转义序列与控制字符
  const stripped = raw.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/[\x00-\x1f\x7f]/g, "");
  const trimmed = stripped.trim();
  if (!trimmed) return null;
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;
}
