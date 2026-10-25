/**
 * 对话页 slash 命令白名单（批 2-2）。
 *
 * 🔴 这一层是**闸门**不是解析器：CC 的 slash 命令由 CLI 自己执行，我们只决定
 *    「哪些命令允许从输入框出去」。三条设计取舍：
 *    - 白名单外的一律不发送。未知命令当普通提示词发给模型只会浪费一轮、还把
 *      模型绕晕；拦住并告诉用户去哪儿用（终端页）比静默透传诚实。
 *    - 不做参数校验。`/model opus` 的参数形状归 CLI，我们连命令一起原样转发。
 *    - 与 shell 无关。输入框里的一切本来都只是发给 CC 的文本；这里再拦一道，
 *      是因为「/」开头的东西用户期望的是命令语义，不是模型语义。
 */

export type SlashCommand = {
  /** 命令名，含前导斜杠。 */
  name: string;
  /** 面板里的一句话说明：说清「谁执行、改变什么」。 */
  desc: string;
  /** 要写参数（`/model opus`）。Enter 在完整命令上只为这类命令填入不发送。 */
  needsArg?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/compact", desc: "压缩上下文：CC 总结前面的对话，窗口占用骤降" },
  { name: "/clear", desc: "清空上下文：之后 CC 不再记得之前聊过的事" },
  { name: "/model", desc: "切换模型：写上模型名，如 /model opus", needsArg: true },
];

/** 白名单文案（提示里用；加命令时不用改提示）。 */
export const SLASH_WHITELIST_TEXT = SLASH_COMMANDS.map((c) => c.name).join("、");

/**
 * 值是不是「正在输命令 token」：`/` 开头且还没打空格。面板据此自动开合。
 *
 * 打上空格意味着在写参数（`/model opus`），那一刻面板必须让位 —— 否则方向键
 * 会被面板吃掉，参数里的空格也成了导航键。
 */
export function isSlashTyping(value: string): boolean {
  return /^\/\S*$/.test(value);
}

/** 面板列表：空 query 出全量，否则按名字包含匹配（不区分大小写）。 */
export function filterSlash(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().includes(q));
}

export type SlashVerdict =
  | { kind: "none" }
  | { kind: "known"; command: SlashCommand }
  | { kind: "unknown"; name: string };

/**
 * 发送前的判定。取首 token **精确**匹配：`/compact;rm`、`/COMPACT`、`/compact!`
 * 一律算未知 —— 白名单要的就是说一不二，容错只会让「命中了哪条」变成猜。
 */
export function classifySlash(text: string): SlashVerdict {
  const t = text.trim();
  if (!t.startsWith("/")) return { kind: "none" };
  const name = t.split(/\s+/)[0];
  const command = SLASH_COMMANDS.find((c) => c.name === name);
  return command ? { kind: "known", command } : { kind: "unknown", name };
}
