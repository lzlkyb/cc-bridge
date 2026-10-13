/**
 * OSC 7501 Program Status Protocol + DEC 2031 主题上报（纯逻辑，无 DOM / 无 React）。
 *
 * 两件事都在这里做纯函数收口，接线点（hooks/useTerminalProtocol.ts）只保留注册与回写：
 *
 * ## ① OSC 7501 —— 让远端程序自己说「我在干什么」
 *
 * `ESC]7501;state=working:app=claude-code:msg=<base64>ST`
 *
 * 价值在于**替代猜**。在此之前要判断 Claude Code 是在干活还是在等用户，只能读窗口标题
 * 找转圈字符（Herdr 为此维护了 16 条规则、三个月改了 10 次）。OSC 7501 让程序直接上报，
 * 而 `blocked:kind=permission` 正好是「它在等你点确认」——这是最该弹系统通知的时刻。
 *
 * **探测**：程序发 `ESC]7501;?`，终端回**同形**序列表示支持（Claude Code 二进制的匹配是
 * `code===7501 && data.startsWith("?")`）。不回 = 探测超时 = 永远「不支持」。
 *
 * ## ② DEC 2031 + `CSI ? 997 ; 1|2 n` —— 让 `theme: auto` 能跟住热切换
 *
 * Claude Code 发 `CSI ? 2031 h` 启用「主题变化通知」后，终端每次主题改变都要发
 * `CSI ? 997 ; 1 n`（深）或 `; 2 n`（亮）。xterm.js 6.0 两个都不实现（bundle 已实证）。
 * 补上后 cc-bridge 是少数能让远端 `auto` 跟随亮暗**实时**切换的终端——
 * 否则只能靠 OSC 11 在会话开头问一次（Windows Terminal 就因不实现 2031 而永不更新，见 #92389）。
 *
 * ⚠️ 回包方向与键入一致（走 ssh_input），不是往本地 xterm 写——远端程序读的是它自己的 stdin。
 */

/** OSC 7501 的状态值。`clear` 不是状态，是「删除该记录」。 */
export type ProgramState = "idle" | "working" | "done" | "blocked" | "error" | "clear";

/** `blocked` 的原因（`kind`）：权限确认 / 提问 / 登录。 */
export type BlockedKind = "permission" | "question" | "auth";

export interface ProgramStatus {
  state: ProgramState;
  /** 仅在 state=blocked 时有值。 */
  kind: BlockedKind | null;
  /** 机器可读的程序名，如 `claude-code`。 */
  app: string | null;
  /** 记录标题（base64 解码后的自由文本）。 */
  title: string | null;
  /** 一句话正文（base64 解码）。blocked 时是「为什么卡住」。 */
  msg: string | null;
  /** 0–100，仅 working 时有意义。 */
  progress: number | null;
}

const STATES: ReadonlySet<string> = new Set(["idle", "working", "done", "blocked", "error", "clear"]);
const KINDS: ReadonlySet<string> = new Set(["permission", "question", "auth"]);

/**
 * 探测应答。规范里终端以「同形序列」回应支持——不是自定义格式，
 * Claude Code 也只检查 data 是否以 `?` 开头（不解析后续内容）。
 */
export const PROGRAM_STATUS_PROBE_REPLY = "\x1b]7501;?\x1b\\";

/** OSC 7501 的 ident。 */
export const PROGRAM_STATUS_OSC = 7501;

/** 是否是「你支持吗」探测（payload 为 `?`）。 */
export function isProgramStatusProbe(data: string): boolean {
  return data.trim() === "?";
}

/**
 * base64 → UTF-8 文本。规范规定自由文本（msg / title）一律 base64，
 * 所以必须先按字节解再按 UTF-8 解——直接 `atob` 得到的是 latin1 串，中文必乱码。
 */
export function decodeBase64Utf8(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null; // 非 base64：当作没有，不猜
  }
}

/**
 * 解析一条 OSC 7501 上报。
 *
 * payload 形如 `state=working:progress=40:app=deploy:msg=<b64>`：
 * key=value 用 `:` 分隔，每对在**第一个** `=` 处切开——base64 的补位 `=` 在值里，
 * 不能按所有 `=` 切。base64 字母表不含 `:`，所以按 `:` 切是安全的。
 *
 * 缺 `state` 或 state 非法 → null（规范要求实现「拒绝非法上报而不是截断」）。
 */
export function parseProgramStatus(data: string): ProgramStatus | null {
  const out: ProgramStatus = {
    state: "idle",
    kind: null,
    app: null,
    title: null,
    msg: null,
    progress: null,
  };
  let seenState = false;
  for (const pair of data.split(":")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const val = pair.slice(eq + 1);
    switch (key) {
      case "state":
        if (!STATES.has(val)) return null;
        out.state = val as ProgramState;
        seenState = true;
        break;
      case "kind":
        out.kind = KINDS.has(val) ? (val as BlockedKind) : null;
        break;
      case "app":
        out.app = val || null;
        break;
      case "title":
        out.title = val ? decodeBase64Utf8(val) : null;
        break;
      case "msg":
        out.msg = val ? decodeBase64Utf8(val) : null;
        break;
      case "progress": {
        const n = Number(val);
        out.progress = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
        break;
      }
      default:
        break; // 未知键忽略（规范预留扩展位）
    }
  }
  return seenState ? out : null;
}

/**
 * 状态栏要显示的一小段文案。null = 不显示。
 *
 * `idle` 与 `clear` 都不显示：一个「安静待命」的程序不该在状态栏常驻一行，
 * 而 done/error 刻意保留（规范要求它们活到被替换或清除），所以这里显示。
 */
export function programStateLabel(p: ProgramStatus): string | null {
  switch (p.state) {
    case "working":
      return p.progress !== null ? `运行中 ${p.progress}%` : "运行中";
    case "blocked":
      switch (p.kind) {
        case "permission":
          return "等待确认";
        case "question":
          return "等待回答";
        case "auth":
          return "等待登录";
        default:
          return "已阻塞";
      }
    case "done":
      return "已完成";
    case "error":
      return "出错";
    default:
      return null;
  }
}

/** 状态栏段的中文悬停说明（补上下文，比如它在问什么）。 */
export function programStateTitle(p: ProgramStatus, label: string): string {
  const app = p.app ?? "远端程序";
  const head =
    p.state === "blocked"
      ? `${app} 正在等你处理（${label}），在你操作前不会继续`
      : `${app} 当前状态：${label}`;
  return p.msg ? `${head}\n${p.msg}` : `${head}（来自 OSC 7501 上报）`;
}

/**
 * 系统通知文案。null = 不通知。
 *
 * 只在 `blocked` 时通知，而且**只在「从非阻塞进入阻塞」时**（去重交给调用方）。
 * 两条理由：
 * - `blocked` 的定义就是「不处理就永远卡住」，这正是「用户走开了」的场景；
 * - `done` 不通知是刻意的——Claude Code 自己会经 `push_notification` MCP 工具推完成通知，
 *   我们再来一条就是重复打扰。
 */
export function blockedNotice(p: ProgramStatus, label: string): { title: string; body: string } | null {
  if (p.state !== "blocked") return null;
  const what =
    p.kind === "permission" ? "需要你确认权限" : p.kind === "auth" ? "需要你重新登录" : p.kind === "question" ? "有一个问题等你回答" : "被阻塞，需要你处理";
  return {
    title: `${label}：${what}`,
    body: p.msg ?? `${p.app ?? "程序"} 已停止输出，等待你的输入`,
  };
}

/* ============================== DEC 2031 ============================== */

/** DECSET 2031（THEME_NOTIFY）：程序启用后，终端在主题变化时须发 997 告知明暗。 */
export const THEME_NOTIFY_MODE = 2031;

/**
 * `CSI ? 997 ; Ps n` —— Ps：`1` = 深色，`2` = 亮色。
 * ⚠️ Claude Code 的解析正则只认这两个值（`^\x1b\[\?997;([12])n$`），别塞别的数。
 */
export function themeNotifyReport(dark: boolean): string {
  return `\x1b[?997;${dark ? 1 : 2}n`;
}

/**
 * CSI 私有模式序列的参数里是否含某个 mode。
 *
 * xterm 的 `registerCsiHandler` 回调收到 `(number | number[])[]`：单个参数是 number，
 * 带子参数（`;` 或 `:` 分段）时是 number[]。`CSI ? 1000;1006 h` → `[1000, 1006]`。
 */
export function csiParamHasMode(params: (number | number[])[], mode: number): boolean {
  for (const p of params) {
    if (Array.isArray(p)) {
      if (p.includes(mode)) return true;
    } else if (p === mode) {
      return true;
    }
  }
  return false;
}
