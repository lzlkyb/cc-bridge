import {
  programStateLabel,
  programStateTitle,
  type ProgramState,
  type ProgramStatus,
} from "./terminalProgramStatus";

/**
 * 标签徽标：把 OSC 7501 的程序状态翻译成「标签栏上一个 12px 的图标」。
 *
 * WHY 需要它：OSC 7501 早在 `c973a12` 就完整接线了（探测应答 → 解析 → 去重 → blocked 通知），
 * 但**唯一展示位是每个 pane 内部的状态栏**——多标签时屏幕上只有当前可见那个 pane 的状态栏，
 * 于是「谁在干活、谁已经做完」在标签栏上完全看不出来。这里把「状态 → 形态」收成纯函数，
 * 组件只管画，映射规则可单测（R11：纯计算归 lib）。
 *
 * 🔴 不猜。没有上报就什么都不显示，不做「最近 N 秒有输出 ⇒ 在干活」的启发式兜底：
 * CC 的 spinner 重绘、流式尾巴、等输入时的画面刷新都会产生终端输出，那个启发式会把
 * 「等你输入」误判成「干活中」——这正是 OSC 7501 要取代的猜法。要么准确，要么没有。
 */

/** 徽标形态：转圈 / 纯色圆点 / 对勾 / 警告三角。 */
export type TabAgentShape = "spinner" | "dot" | "check" | "alert";

/**
 * 这个状态是「得有人去看一眼」吗——决定它要不要参与未读机制。
 *
 * - `working` **不算**：转圈本身就在表达「在干活」，没有人需要为此切过去；
 *   把它算进来会让每个后台在跑的标签都变成未读，未读就失去区分度。
 * - `blocked` / `done` / `error` 都算：一个在等你拍板、一个产出了要看的结果、
 *   一个崩了要看错误，三者都是「不看就漏掉」。
 * - `idle` / `clear` 不算：安静待命不该打扰，`clear` 更是连记录都删了。
 */
export function attentionState(state: ProgramState): boolean {
  return state === "blocked" || state === "done" || state === "error";
}

export interface TabAgentBadge {
  shape: TabAgentShape;
  /** 是否转动（只有 working 转，且 `animate-spin` 在 `[data-app-hidden]` 暂停清单里）。 */
  spin: boolean;
  /**
   * 属于「需要你看」的那一档（同 `attentionState`）。渲染层据此决定要不要按已读降级：
   * 未读画实色，已读压暗并停掉呼吸。`working` 恒 false ⇒ 永远不受已读影响。
   */
  needsAttention: boolean;
  /**
   * 配色类，亮暗两套一起给（`text-teal-600 dark:text-teal-400` 这种产品既有写法）。
   * blocked 的圆点是**填充**色，所以用 `bg-`。
   */
  colorClass: string;
  /** 无障碍名（`role="img"` 的 aria-label）。 */
  label: string;
  /** 悬停说明：复用状态栏的 `programStateTitle`，带上 CC 上报的 msg（它在问什么）。 */
  tooltip: string;
}

/**
 * 状态 → 徽标。`null` = 不显示。
 *
 * `idle` / `clear` / 从未上报一律不显示：安静待命不该在标签上占位，
 * 「没在干活」由「没有转圈」本身表达，再加一个灰点只会让每行标签都多一格噪声。
 *
 * 取色沿用状态栏 `AGENT_KIND` 的**语义**（working=信息色、blocked=warn、done=ok、error=错），
 * 但落地用产品 UI token 而不是状态栏皮肤——标签栏不属于终端配色体系，四套皮肤不该管到这里。
 * ⚠️ working 不能用琥珀：那是 warn 的专属语义色，用掉之后「等确认」就不醒目了。
 */
export function tabAgentBadge(agent: ProgramStatus | null): TabAgentBadge | null {
  if (!agent) return null;
  const label = programStateLabel(agent);
  if (label === null) return null; // idle / clear：状态栏也不显示，标签上同样不占位
  const tooltip = programStateTitle(agent, label);
  const needsAttention = attentionState(agent.state);
  switch (agent.state) {
    case "working":
      return {
        shape: "spinner",
        spin: true,
        needsAttention,
        colorClass: "text-teal-600 dark:text-teal-400",
        label,
        tooltip,
      };
    case "blocked":
      // 最醒目的一档：它意味着「不处理就永远卡在 stderr 等输入」。
      return {
        shape: "dot",
        spin: false,
        needsAttention,
        colorClass: "bg-amber-500 dark:bg-amber-400",
        label,
        tooltip,
      };
    case "done":
      return {
        shape: "check",
        spin: false,
        needsAttention,
        colorClass: "text-green-600 dark:text-green-400",
        label,
        tooltip,
      };
    case "error":
      return {
        shape: "alert",
        spin: false,
        needsAttention,
        colorClass: "text-destructive-ink",
        label,
        tooltip,
      };
    default:
      return null;
  }
}

/**
 * 旧版 CC（< 2.1.295）不发 OSC 7501。若该标签**有 OSC 标题**（说明有 TUI 在跑）却没有任何
 * 程序状态，就在标签 tooltip 尾部补一句弱提示。
 *
 * 纯 shell 标签不加：它根本没有 CC 可报，加了只是噪声。
 *
 * 返回值带前导换行（直接拼进 `title` 属性，多行 tooltip 可读）；不适用时返回空串，
 * 调用方无需判空——这也是它不用 `null` 的原因。
 */
export function tabAgentMissingHint(hasTitle: boolean, agent: ProgramStatus | null): string {
  if (!hasTitle || agent !== null) return "";
  return "\n未上报程序状态（OSC 7501；CC 2.1.295 起才发）";
}
