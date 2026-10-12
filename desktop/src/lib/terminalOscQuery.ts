/**
 * OSC 10/11 颜色查询应答器（纯逻辑，无 DOM / 无 React）。
 *
 * WHY：Claude Code 的 `theme: auto` 靠向终端发 OSC 11 查询（“你的背景色是什么？”）
 * 来决定用亮色还是暗色渲染——但 xterm.js 6.0 **不实现 OSC 10/11 应答**（bundle 已实证）。
 * 查询石沉大海，Claude Code 回退到 dark：亮色主题下用户消息块就是一块近黑的
 * truecolor 底色（上游 anthropics/claude-code #49848 / #86048 同因）。
 *
 * 解法：SSH 出站数据在喂给 xterm 之前经过本文件的一层流式拦截——
 * 匹配到 `ESC]10;?` / `ESC]11;?`（BEL 或 ST 结尾）就剥离该序列，并按**当前**
 * 终端主题的 foreground/background 回写应答（走 ssh_input 通道，方向与键入一致）。
 * 远端拿到底色后 auto 模式就能真正跟随桥的亮暗主题。
 *
 * 纯函数收口（规则 11）：流式缓冲、前缀判定、应答构造全部在这里做单测；
 * 接线点（useSshTerminalSession）只保留 3 行。
 */

/** 一次应答需要的两个颜色（来自当前 xterm ITheme）。 */
export interface OscQueryColors {
  fg: string;
  bg: string;
}

/** 从 xterm ITheme 取 fg/bg（两键在类型上可选，但我们的 8 套色盘全部显式给出；兜底只为类型完备）。 */
export function paletteColors(t: { foreground?: string; background?: string }): OscQueryColors {
  return { fg: t.foreground ?? "#000000", bg: t.background ?? "#ffffff" };
}

/**
 * 查询形态：`ESC ] 10|11 ; ?` + BEL(`\x07`) / ST(`\x1b\\`) / 或直接接下一个
 * `ESC]`（合并查询 `ESC]10;?ESC]11;?ST`——首个子查询无终止符，前瞻不消费它）。
 * 单条正则按最左匹配，保证合并形态的第一个子查询先于第二个被剥离。
 */
// eslint-disable-next-line no-control-regex -- OSC 转义序列本身由 ESC/BEL 控制字符构成，此处的 \x1b/\x07 是协议常量而非脏输入
const QUERY_RE = /\x1b\](10|11);\?(?:\x07|\x1b\\|(?=\x1b\]))/g;

/** 所有查询模式的公共前缀（供跨 chunk 缓冲判定用）。 */
const QUERY_HEADS = ["\x1b]10;?\x07", "\x1b]11;?\x07", "\x1b]10;?\x1b\\", "\x1b]11;?\x1b\\"];
/** 最长完整查询的字节数（`\x1b]10;?` + ST = 9）。缓冲最多只可能积压这么多。 */
const MAX_QUERY_LEN = 9;

/** `#rgb` / `#rrggbb` → xterm 应答格式 `rgb:rrrr/gggg/bbbb`（每通道 4 位十六进制）。 */
export function hexToOscRgb(hex: string): string | null {
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const expand = (pair: string) => pair + pair;
  return `rgb:${expand(h.slice(0, 2))}/${expand(h.slice(2, 4))}/${expand(h.slice(4, 6))}`;
}

/** 构造一条 OSC 颜色应答（ST 结尾；xterm 对查询的应答惯例）。 */
export function buildOscColorReply(kind: 10 | 11, hex: string): string | null {
  const rgb = hexToOscRgb(hex);
  return rgb === null ? null : `\x1b]${kind};${rgb}\x1b\\`;
}

export interface OscQueryResponder {
  /**
   * 喂一段出站数据，返回应继续喂给 xterm 的内容（查询已剥离；可能是空串）。
   * 查询命中时同步调用 `reply` 回写应答——用查询到达那一刻的主题色，
   * 主题热切换后新到达的查询自然用新色，无需重建 responder。
   */
  feed: (chunk: string) => string;
}

/**
 * 创建流式应答器。跨 chunk 安全：尾部若恰好是某查询的前缀（如 `\x1b]1`），
 * 先扣住不发，等下一个 chunk 拼上再判定——扣住上限 9 字节，延迟可忽略。
 */
export function createOscQueryResponder(opts: {
  colors: () => OscQueryColors;
  reply: (data: string) => void;
}): OscQueryResponder {
  let pending = "";

  const feed = (chunk: string): string => {
    pending += chunk;
    let out = "";
    for (;;) {
      QUERY_RE.lastIndex = 0;
      const m = QUERY_RE.exec(pending);
      if (m === null) break;
      out += pending.slice(0, m.index);
      pending = pending.slice(m.index + m[0].length);
      const colors = opts.colors();
      const data = buildOscColorReply(m[1] === "10" ? 10 : 11, m[1] === "10" ? colors.fg : colors.bg);
      if (data !== null) opts.reply(data);
    }
    // 尾部扣留：找到最长的 k ≤ MAX_QUERY_LEN，使 pending 的末 k 字节是某查询的前缀。
    let hold = 0;
    for (let k = Math.min(MAX_QUERY_LEN, pending.length); k > 0; k--) {
      const tail = pending.slice(-k);
      if (QUERY_HEADS.some((q) => q.startsWith(tail))) {
        hold = k;
        break;
      }
    }
    out += pending.slice(0, pending.length - hold);
    pending = pending.slice(pending.length - hold);
    return out;
  };

  return { feed };
}
