import type { IProgressState } from "@xterm/addon-progress";
import type { ProgramStatus } from "./terminalProgramStatus";
import { attentionState } from "./terminalTabAgent";

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
  /**
   * OSC 7501 程序状态（CC 自报「在干活 / 等你确认 / 做完了」），null = 没上报。
   *
   * WHY 要放进标签 meta：状态栏里的 AgentSeg 只在**当前可见的 pane** 里，
   * 多标签时看不出后台标签谁在跑。这里存一份，标签栏才能常驻显示徽标。
   */
  agent: ProgramStatus | null;
  /**
   * 「这个标签变成**需要你看**的状态之后，你还没回来看过」。
   *
   * WHY 要单独一个维度：`agent` 只说「现在是什么状态」，说不出「你知不知道」。
   * 没有它就有两个可见缺陷（2026-11-02 调研 VS Code / iTerm2 / Warp / kanban 后确认）：
   * ① 二十分钟前的阻塞和刚出现的阻塞长得一模一样，没法按紧急度扫；
   * ② 跑一下午回来看到满排绿 ✓，全是很久以前做完的，等于没有信号。
   *
   * 置位：`patchMeta` 发现 agent 新进入 blocked / done / error 时置 true（见 `attentionState`）。
   * 清零：切换标签时（activeId 变化）把**离开的和进入的两个**都清——进入的清是为了
   * 「切过去即已读」，离开的清是因为「刚才那一眼已经看到了」。
   * 🔴 刻意**不做超时淡出**：定时把未读抹掉等于「几分钟前做完的重新变回没看过」，
   * 比一直亮着更误导。已读与否只由「用户真的看过」决定。
   */
  agentUnread: boolean;
}

export const EMPTY_TAB_META: TermTabMeta = {
  title: null,
  progress: null,
  bellAt: null,
  agent: null,
  agentUnread: false,
};

/**
 * `patchMeta` 的合并核心：浅合并 + **按值去重**。
 *
 * 返回 `cur` 本身表示「一个字都没变」，调用方据此跳过 setState——标签栏少一次无谓重渲染。
 * 之所以值得单独成函数：四个字段各有一套比较方式，
 * - `title` / `bellAt` 是标量，直接比；
 * - `progress` 是 addon 每次 onChange 新造的对象，要比 `state`/`value`（rsync 之类的包装器
 *   会周期性重发同一个百分比）；
 * - `agent` 同样是对象，而 CC 规范要求**每条上报都带完整元数据**（working 会连着发很多遍），
 *   只比引用等于没去重；`msg` 也要比，它就是 tooltip 里「它在问什么」那句。
 *
 * 未读标记的推导也在这里：新的 `agent` 是**新的一条** blocked/done/error 才置位——
 * 判 `!agentSame` 而不是「是 attention 档」，否则用户刚清掉的未读会被下一次重发重新点亮。
 * 调用方显式传了 `agentUnread`（切标签清零走这条）时不覆盖，语义上「显式 > 推导」。
 */
export function mergeTabMeta(cur: TermTabMeta, p: Partial<TermTabMeta>): TermTabMeta {
  const next: TermTabMeta = { ...cur, ...p };
  const progressSame =
    next.progress === cur.progress ||
    (next.progress != null &&
      cur.progress != null &&
      next.progress.state === cur.progress.state &&
      next.progress.value === cur.progress.value);
  const agentSame =
    next.agent === cur.agent ||
    (next.agent != null &&
      cur.agent != null &&
      next.agent.state === cur.agent.state &&
      next.agent.kind === cur.agent.kind &&
      next.agent.progress === cur.agent.progress &&
      next.agent.msg === cur.agent.msg);
  if (p.agentUnread === undefined && p.agent != null && !agentSame && attentionState(p.agent.state)) {
    next.agentUnread = true;
  }
  if (
    next.title === cur.title &&
    progressSame &&
    next.bellAt === cur.bellAt &&
    agentSame &&
    next.agentUnread === cur.agentUnread
  ) {
    return cur;
  }
  return next;
}

/**
 * 把给定会话的未读标记清零；没有需要清的就返回原对象（调用方据此跳过 setState）。
 *
 * 一次传多个 id 是因为切换标签要清**两个**：进入的那个（切过去就算看过）和离开的那个
 * （刚才停在那一页的那一眼已经看到了）。只清进入的，「盯着它跑完再切走」会永久高亮。
 */
export function clearTabMetaUnread(
  meta: Record<string, TermTabMeta>,
  ids: readonly string[],
): Record<string, TermTabMeta> {
  let next: Record<string, TermTabMeta> | null = null;
  for (const id of ids) {
    const cur = meta[id];
    if (!cur?.agentUnread) continue;
    if (!next) next = { ...meta };
    next[id] = { ...cur, agentUnread: false };
  }
  return next ?? meta;
}

/**
 * 标签栏汇总用的最小形状。**故意不引 `SshSessionRef`**：那在组件层
 * （`components/tabs/TerminalConnectionItem.tsx`），lib 反向依赖组件会让这层彻底拧起来。
 */
export interface AttentionTabRef {
  sessionId: string;
  /** 已断开（主动断或掉线）。它不进「待处理」那一档，但有自己的一档。 */
  closed: boolean;
}

/** 汇总的两档。**必须分开**：它们要的颜色、要的动作、紧急程度都不一样。 */
export interface TabAttentionSummary {
  /** 需要你看的（blocked / done / error 且未读）。与标签上的徽标同源。 */
  attention: string[];
  /** 已断开的会话：等你重连或关掉。 */
  disconnected: string[];
}

/**
 * 标签栏右端汇总的两组 sessionId，按标签顺序。
 *
 * 「待处理」只数 `agentUnread`（用户还没看过的 blocked/done/error）。它和标签上那个徽标同源，
 * 所以数字永远等于「标签栏里亮着几个徽标」——两处对不上就会让用户怀疑哪边在骗人。
 * 分屏副格由调用方先滤掉（它本来就不占标签位，重复计会让数字与眼睛看到的标签数不符）。
 *
 * 🔴 「已断开」以前是 `continue` 掉的（2026-11-02 的实现），理由是「断开是另一个维度」。
 * 那是错的：断线恰恰是**最需要你动手**的一档——不重连它就永远是个死标签，不关掉它就一直占位。
 * 而标签上的断线表现是删除线 + 暗红点，读起来像「已经删了」，不像「出事了」，扫视时最容易漏。
 */
export function tabAttentionSummary(
  tabs: readonly AttentionTabRef[],
  meta: Record<string, TermTabMeta>,
): TabAttentionSummary {
  const attention: string[] = [];
  const disconnected: string[] = [];
  for (const t of tabs) {
    if (t.closed) {
      disconnected.push(t.sessionId);
      continue;
    }
    const m = meta[t.sessionId];
    // 🔴 必须连 `attentionState` 一起判，不能只看 `agentUnread`：CC 可能把状态改回 idle
    // 而没有新的 attention 上报，此时徽标已经不画了（idle 不占位）却还留着未读标记
    // ⇒ 药丸数了一格「看不见的待处理」，数字和标签栏对不上。
    if (m?.agentUnread && m.agent != null && attentionState(m.agent.state)) {
      attention.push(t.sessionId);
    }
  }
  return { attention, disconnected };
}

/**
 * 环里的下一个标签（走到末尾回到开头）。空列表返回 null。
 *
 * `current` 是当前激活的标签：通常已经不在 `list` 里（切过去就清读了），此时从头开始；
 * 万一它还在（比如刚上报新状态还没清），就往下走一个，避免「点了没反应」。
 * 两档汇总共用这一个推进规则——否则「待处理」和「已断开」的点击手感会不一样。
 */
export function nextTabInRing(list: readonly string[], current: string | null): string | null {
  if (list.length === 0) return null;
  const i = current ? list.indexOf(current) : -1;
  return list[(i + 1) % list.length];
}

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

/**
 * OSC 9;4 进度条在标签底部的配色与几何（条宽按 value%）。
 *
 * 从 `TerminalTabsBar` 搬到这里（2026-11-02）：纯计算留在组件里既挡住徽标入场，
 * 又让「哪个 state 配哪个色」这条规则没法单测。
 * 状态码抄的是 ConEmu 协议：0=隐藏（调用方已滤掉）、1=正常、2=出错、3=不确定、4=暂停。
 */
export function progressStyle(p: IProgressState): { className: string; width: string } {
  switch (p.state) {
    case 1:
      return { className: "bg-primary", width: `${Math.min(100, Math.max(0, p.value))}%` };
    case 2:
      return { className: "bg-destructive", width: `${Math.min(100, Math.max(0, p.value)) || 100}%` };
    case 3:
      return { className: "bg-primary animate-pulse", width: "100%" };
    case 4:
      return { className: "bg-amber-500", width: `${Math.min(100, Math.max(0, p.value)) || 100}%` };
    default:
      return { className: "", width: "0%" };
  }
}
