import type { CSSProperties } from "react";
import type { TerminalPreset } from "./terminalTheme";
import { getStoredTheme, type Theme } from "./theme";
import { getTmuxBridgeEnabled } from "./terminalPreset";
import { loadTuiScrollSpeed } from "./terminalScrollSpeed";

/**
 * 终端状态栏：四套风格的样式 token + OSC 解析纯函数。
 *
 * 借鉴 Starship 的「模块化段 + 单配置驱动」思路，但**不要求用户写 TOML**：
 * 段有哪些、什么顺序由本文件决定，用户只选一套风格。
 *
 * WHY 单独成文件：状态栏的段色/分隔/排版是**纯数据**，与渲染组件分离后
 * 新增风格只改这里（规则 11：公共纯数据/纯函数归 lib）。
 *
 * 🔴 每套都给了 dark/light 两套段色，不能只给深色：状态栏直接坐在终端画布上方，
 * 画布底色（`TERMINAL_SURFACE`）是跟随主题的。若段色写死深色，切到亮色主题时
 * 青色（#22d3ee 压白底 ≈1.8:1）会糊成一片——这与 `terminalTheme.ts` 里
 * `brightGreen` 必须为亮底单独取值的坑是同一类。
 */

/** 段类型。新增段只需在这里加一个 key，并在下面四套 token 里各补一个色。 */
export type SegKind = "host" | "path" | "git" | "exit" | "exitBad" | "muted" | "tui" | "warn";

export interface StatusbarSkin {
  /**
   * 状态栏容器。融卡设计（2026-10-15）：统一 transparent、无底线——状态栏与
   * xterm 画布同底色（surface）同边距（px-2），视觉上是一张无缝大卡；
   * 独立底色/分隔线会让它看起来像「贴在卡上的另一条」。段色对比由各皮肤
   * colors 直接对 surface 保证。
   */
  bar: CSSProperties;
  /** 单个段的基础样式（颜色另按 SegKind 取）。 */
  seg: CSSProperties;
  /** 段间分隔符字符；null = 用左边框分隔（靖蓝/高对比的做法）。 */
  divider: string | null;
  dividerColor: string;
  /** true = 段画成实心色块（高对比），此时 colors 用作**背景**、text 用作文字色。 */
  solid: boolean;
  /** 是否显示图标（极简风格刻意不要图标）。 */
  icons: boolean;
  colors: Record<SegKind, string>;
  /** solid 模式下的文字色；非 solid 模式不使用。 */
  text: string;
}

/**
 * 段的基础样式。**刻意不含 `fontFamily`**：用户可以在设置里换终端字体，
 * 而段的内联样式会盖掉继承值——写死在这里就会和终端画布用上两套字体。
 * 字体由状态栏容器统一设置（`TerminalStatusBar`），Seg / Divider 从它继承。
 *
 * 顺带修掉了旧值缺中文回退的问题（旧值只到 Consolas，中文会掉到系统默认字体）。
 */
const SEG_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  whiteSpace: "nowrap",
};

/* ============================== 靖蓝 Indigo ============================== */
/** 段色沿用连接页语言：indigo 主色 + cyan 辅助。默认。容器融卡（见 bar 注）。
 * 🔴 tui（信息段）任何皮肤都不得用琥珀系——那是 warn/dead 的专属语义色，
 * 「TUI 滚动」(正常) 与「⚠ 滚轮不可用」(故障) 撞色会废掉状态栏的分诊通道
 *（2026-10-13 critique P1-2）。各皮肤 tui 统一走各自的冷色系信息色。 */
const INDIGO: Record<Theme, StatusbarSkin> = {
  dark: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "1px 9px" },
    divider: null,
    dividerColor: "rgba(255,255,255,.09)",
    solid: false,
    icons: true,
    colors: {
      host: "#818cf8",
      path: "#22d3ee",
      git: "#a78bfa",
      exit: "#22c55e",
      exitBad: "#ef4444",
      muted: "#8a90a2",
      tui: "#5eead4",
      warn: "#f2c268",
    },
    text: "",
  },
  light: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "1px 9px" },
    divider: null,
    dividerColor: "rgba(0,0,0,.08)",
    solid: false,
    icons: true,
    colors: {
      host: "#4f46e5",
      path: "#0e7490",
      git: "#7c3aed",
      exit: "#15803c",
      exitBad: "#dc2626",
      muted: "#6b7280",
      tui: "#0d9488",
      warn: "#a3620a",
    },
    text: "",
  },
};

/* ============================== 极简 Mono ============================== */
/** 无底色、无图标、细点分隔。给不想被打扰的重度用户。 */
const MONO: Record<Theme, StatusbarSkin> = {
  dark: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "0 8px" },
    divider: "·",
    dividerColor: "#4b5162",
    solid: false,
    icons: false,
    colors: {
      host: "#6366f1",
      path: "#c3c8d4",
      git: "#b0b6c4",
      exit: "#22c55e",
      exitBad: "#ef4444",
      muted: "#7a8090",
      tui: "#5eead4",
      warn: "#e0a94f",
    },
    text: "",
  },
  light: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "0 8px" },
    divider: "·",
    dividerColor: "#c3c8d4",
    solid: false,
    icons: false,
    colors: {
      host: "#4f46e5",
      path: "#1f2937",
      git: "#4b5563",
      exit: "#15803c",
      exitBad: "#dc2626",
      muted: "#6b7280",
      tui: "#0d9488",
      warn: "#a3620a",
    },
    text: "",
  },
};

/* ============================== 经典终端 ============================== */
/**
 * 深色 = CRT 磷光绿（带辉光）；亮色 = **暖纸感**。
 *
 * 🔴 亮色变体不能硬套磷光绿：高亮度绿压白底对比度不达标，与 `terminalTheme.ts`
 * 里 classic.light 走暖纸感是同一个理由。
 */
const CLASSIC: Record<Theme, StatusbarSkin> = {
  dark: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "1px 9px", textShadow: "0 0 6px rgba(34,197,94,.35)" },
    divider: "│",
    dividerColor: "#1f3d24",
    solid: false,
    icons: true,
    colors: {
      host: "#7dfca6",
      path: "#7dfca6",
      git: "#d7f76a",
      exit: "#22c55e",
      exitBad: "#ff5f56",
      muted: "#4a8a5c",
      tui: "#7dfce0",
      warn: "#f2c268",
    },
    text: "",
  },
  light: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "1px 9px" },
    divider: "│",
    dividerColor: "#c8bfa5",
    solid: false,
    icons: true,
    colors: {
      host: "#1e7a3c",
      path: "#14532d",
      git: "#4d7c0f",
      exit: "#15803c",
      exitBad: "#b91c1c",
      muted: "#6b6255",
      tui: "#0f766e",
      warn: "#8a5a0c",
    },
    text: "",
  },
};

/* ============================== 高对比 ============================== */
/** 实心色块 + 深/浅反色字，对比度最高。弱光、投影、无障碍场景。 */
const CONTRAST: Record<Theme, StatusbarSkin> = {
  dark: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "2px 8px", marginRight: 5, borderRadius: 4, fontWeight: 700 },
    divider: null,
    dividerColor: "transparent",
    solid: true,
    icons: true,
    colors: {
      host: "#818cf8",
      path: "#67e8f9",
      git: "#c4b5fd",
      exit: "#86efac",
      exitBad: "#fca5a5",
      muted: "#9ca3af",
      tui: "#5eead4",
      warn: "#f0b429",
    },
    text: "#0b0d11",
  },
  light: {
    bar: { background: "transparent" },
    seg: { ...SEG_BASE, padding: "2px 8px", marginRight: 5, borderRadius: 4, fontWeight: 700 },
    divider: null,
    dividerColor: "transparent",
    solid: true,
    icons: true,
    colors: {
      host: "#4338ca",
      path: "#0e7490",
      git: "#6d28d9",
      exit: "#15803c",
      exitBad: "#b91c1c",
      muted: "#4b5563",
      tui: "#0f766e",
      warn: "#b45309",
    },
    text: "#ffffff",
  },
};

/** 4 套风格 × 亮/暗。与 `TERMINAL_PALETTES` 一一对应，切风格时两者同时生效。 */
export const STATUSBAR_SKINS: Record<TerminalPreset, Record<Theme, StatusbarSkin>> = {
  indigo: INDIGO,
  mono: MONO,
  classic: CLASSIC,
  contrast: CONTRAST,
};

/* ============================== 展示用纯函数 ============================== */

/** 绝对路径截断：超过 keep 层时只留最后 keep 层，前缀 `…/`。 */
export function shortenPath(p: string, keep = 3): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join("/")}`;
}

/** 会话时长：秒 → `42s` / `12m` / `1h05m`。 */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/* ============================== OSC 解析 ============================== */
/*
 * 三条序列（iTerm2 / FinalTerm 的 shell 集成标准，VS Code 与 Warp 同族）：
 * - OSC 7  `file://host/path`      → 远端当前目录
 * - OSC 133 `D;<exit>`             → 上一条命令结束，附退出码
 * - OSC 1337 `Key=Value`           → 私有扩展，这里用 Shell=（探针）与 Git=（分支）
 *
 * xterm.js 的 `parser.registerOscHandler(ident, cb)` 回调收到的 data 是
 * **ident 与紧随其后的那个 `;` 之后**的内容（**不含**分号），与 ident 本身无关。
 * 实证：`ESC]7;file://h/p` → data=`file://h/p`、`ESC]7501;?` → data=`?`
 * （无头 Edge + 真实 xterm 测过；此处曾误写为「含第一个 `;`」）。
 */

/** OSC 7 → 绝对路径。非 file:// 或无可解析路径时返回 null。 */
export function parseOsc7(data: string): string | null {
  if (!data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const raw = rest.slice(slash);
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    /* 路径里有非法 % 转义（极少见）：用原始串，不因此丢掉整段 */
  }
  return path || "/";
}

/** OSC 133 → 退出码。只认 `D;<code>`（`C` 是命令开始，暂不用于显示）。 */
export function parseOsc133(data: string): number | null {
  const parts = data.split(";");
  if (parts[0] !== "D" || parts.length < 2) return null;
  // 🔴 `Number("")` 是 0（Number.isFinite(0) 为真），必须显式排除空串，否则 `D;` 会被误判为退出码 0。
  if (parts[1] === "") return null;
  const code = Number(parts[1]);
  return Number.isFinite(code) ? code : null;
}

/** OSC 1337 → 私有键值。只认 Shell=（探针回执）与 Git=（分支）。 */
export function parseOsc1337(data: string): { shell?: string; git?: string } {
  const eq = data.indexOf("=");
  if (eq === -1) return {};
  const key = data.slice(0, eq);
  const val = data.slice(eq + 1);
  if (key === "Shell") return { shell: val };
  if (key === "Git") return { git: val };
  return {};
}

/* ============================== 注入的 shell 钩子 ============================== */

/**
 * 探针：向远端询问 shell 类型（OSC 1337;Shell=$0）。
 *
 * ⚠️ 回执**不等于**「远端是 bash/zsh」：本命令只要求远端 shell 能执行 printf，
 * fish / ksh / dash 同样能执行并回执（回执值就是它们的 $0，如 "fish"）。
 * 所以「收到回执才注入钩子」挡不住非 bash/zsh —— 真正的门禁是
 * `isSupportedShell()`（钩子是 bash/zsh 语法，盲发会在 fish/csh/sh 屏幕上
 * 喷语法错误，与回显残渣同类）。探针的价值是拿到 shell 名给门禁判定 + 时序同步。
 *
 * 注意 `$0` 在登录 shell 下通常是 `-bash` / `-zsh`（带前导 `-`），判定时要剥掉。
 */
export const PROBE_CMD = `printf '\\033]1337;Shell=%s\\007' "$0"`;

/**
 * 探针回执 → 该 shell 是否可以注入钩子。
 *
 * 白名单只收 bash / zsh（容忍登录 shell 的 `-` 前缀）。其余一律 false：
 * - fish/csh/tcsh：语法不通，盲发 = 屏幕喷错；
 * - sh/dash/ksh/ash：能定义函数，但 PROMPT_COMMAND 与 precmd_functions 都不存在，
 *   `precmd_functions+=(...)` 这句要么语法报错要么静默无效——注入零收益、纯风险；
 * - pwsh/cmd 等：同理。
 */
export function isSupportedShell(name: string): boolean {
  const s = name.trim().replace(/^-/, "").toLowerCase();
  return s === "bash" || s === "zsh";
}

/**
 * 会话环境注入：在远端 shell 里 `export` 变量，供 Claude Code 等程序读取。
 *
 * WHY 用「注入 export」而不是 spawn 时设 env：SSH 的远端环境由 sshd 决定，本地
 * `Command::env()` 传不过去（`ssh -o SetEnv` 还要服务端 AcceptEnv，默认拒绝）。
 * 我们自己往**活 shell** 里打字，这是别的终端没有的位置优势。
 *
 * 注入三件事：
 * - `COLORFGBG`：`theme: auto` 走**异步** OSC 11 时高亮层拿不到结果 → 代码块白底白字（#56848）。
 *   这个变量是**同步可见**的（首帧就有值），SSH 过来默认不存在。取值 `fg;bg`（暗 `15;0`、亮 `0;15`）。
 *   ⚠️ 只在会话建立时注入一次，之后热切主题不会重发：运行中的 Claude Code 由 OSC 2031 通知兜底。
 * - `CLAUDE_CODE_SCROLL_SPEED`：决定 TUI 内滚轮每格滚几行（对方内部 clamp 到 20）。
 *   直接复用用户在设置页选的 TUI 滚动速度，两处手感一致。
 * - `CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK`：Claude Code 自己也有一层
 *   「用户在场就不通知」的判定，与 `useTerminalProtocol` 里的 `visible && document.hasFocus()`
 *   静默**叠加会漏通知**（人走开了两边都不发）。关掉远端那层，由我们统一决定弹不弹原生通知。
 */
export function envInjectCmd(): string {
  const colorfgbg = getStoredTheme() === "dark" ? "15;0" : "0;15";
  return (
    `export COLORFGBG='${colorfgbg}'` +
    ` CLAUDE_CODE_SCROLL_SPEED='${loadTuiScrollSpeed()}'` +
    ` CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK='1';`
  );
}

/**
 * tmux 桥接：tmux 内默认坏三件事 —— ① 桌面通知与进度条到不了外层终端；
 * ② Shift+Enter 被当成提交；③ OSC 52 复制被吞（Claude Code 在 tmux 内会把 OSC 52
 * 包进 DCS passthrough，不开 passthrough 就丢）。
 *
 * 三条 `tmux set` 作用于**运行中的 server**、不改用户的 `.tmux.conf`；但它们是**全局**设置，
 * 会影响该用户同机的其它 tmux 会话 —— 故只在用户开启「tmux 桥接」时注入（默认关）。
 * `2>/dev/null` 吃掉旧版 tmux 不认某选项时的报错，避免污染屏幕。
 */
export function tmuxBridgeCmd(): string {
  return [
    `if [ -n "$TMUX" ]; then`,
    `tmux set -g allow-passthrough on 2>/dev/null;`,
    `tmux set -s extended-keys on 2>/dev/null;`,
    `tmux set -as terminal-features 'xterm*:extkeys' 2>/dev/null;`,
    `fi;`,
  ].join(" ");
}

/**
 * 提示符钩子（bash 走 PROMPT_COMMAND，zsh 走 precmd_functions）。
 *
 * 设计取舍，改动前请三思：
 *
 * 1. **只读取、不修改画面**：钩子只 printf 三条 OSC，不改 PS1、不写任何文件、
 *    不动 .bashrc/.zshrc。改 PS1 是另一量级的侵入，产品上明确不做。
 * 2. **git 分支按目录缓存**：`git rev-parse` 每次提示符都跑会拖慢手感（大仓库几十毫秒），
 *    所以只在 `$PWD` 变化时重跑。这正是 Starship「每段独立探测 + 缓存」的做法。
 * 3. **耗时口径是「提示符→提示符」而非「命令执行」**：精确测出命令本身的执行时间需要
 *    `133;C`（bash 的 DEBUG trap / zsh 的 preexec），而 DEBUG trap 在钩子函数内部也会被
 *    触发，得用标志位过滤，脆弱且易误报 —— 明确不做。所以耗时是 A 钉点 → D 到达的间隔，
 *    含用户敲命令的时间。状态栏文案据此写「上一条」而非「本条执行」，不宣称精确。
 *
 * 🔴 **每次提示符必须连发 `133;D;<code>` 与 `133;A`，且 D 在前**：
 *    `terminalCommandNav` 靠 D 把退出码/耗时回填到「刚跑完的那一块」，靠 A 钉下一块的
 *    起点 marker。两者顺序反了，退出码与耗时会整体错位一格。
 *    （2026-10-13 修：此前只发 D 没发 A → 命令导航与耗时**从未生效**过。）
 */
export function hookCmd(): string {
  return [
    envInjectCmd(),
    ...(getTmuxBridgeEnabled() ? [tmuxBridgeCmd()] : []),
    `__ccb_p(){`,
  `local e=$?;`,
  `local d="$PWD";`,
  // 🔴 D 在前、A 在后（顺序不能换）：D 落在刚跑完的那一块上，A 钉下一块的起点。
  `printf '\\033]133;D;%s\\007\\033]133;A\\007\\033]7;file://%s%s\\007' "$e" "$HOSTNAME" "$d";`,
  `if [ "$d" != "$__ccb_d" ]; then`,
  `__ccb_d="$d";`,
  `local b="";`,
  `b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null);`,
  `if [ -n "$b" ]; then printf '\\033]1337;Git=%s\\007' "$b"; fi;`,
  `fi;`,
  `return 0;`,
  `};`,
  `if [ -n "$BASH_VERSION" ]; then`,
  // 🔴 `\${` 的反斜杠**不能删**：那是 JS 模板字符串的插值语法，`${PROMPT_COMMAND:+;...}`
  // 会被当成插值、而 `PROMPT_COMMAND` 在 JS 里未定义 → ReferenceError。
  // 后面的 `$PROMPT_COMMAND` 是 shell 变量，前面没有 `{`，不需要转义（加了会被 eslint 报
  // no-useless-escape）。两者长得像，改这行前先分清哪个是给 JS 看的、哪个是给 shell 看的。
  `PROMPT_COMMAND="__ccb_p\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";`,
  `else`,
  `precmd_functions+=("__ccb_p");`,
  `fi`,
  ].join(" ");
}

/** OSC 133 的 A 事件（新提示符 / 命令起点）。命令导航（terminalCommandNav）用它钉 marker。 */
export function isOsc133A(data: string): boolean {
  return data === "A" || data.startsWith("A;");
}
