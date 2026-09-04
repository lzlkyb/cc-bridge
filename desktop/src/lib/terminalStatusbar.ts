import type { CSSProperties } from "react";
import type { TerminalPreset } from "./terminalTheme";
import type { Theme } from "./theme";

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
export type SegKind = "host" | "path" | "git" | "exit" | "exitBad" | "muted";

export interface StatusbarSkin {
  /** 状态栏容器。 */
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

const SEG_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  whiteSpace: "nowrap",
  fontFamily:
    'ui-monospace, SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
};

/* ============================== 靖蓝 Indigo ============================== */
/** 与连接页同语言：indigo 主色 + cyan 辅助，玻璃渐变底。默认。 */
const INDIGO: Record<Theme, StatusbarSkin> = {
  dark: {
    bar: {
      background: "linear-gradient(90deg, rgba(99,102,241,.14), rgba(34,211,238,.07))",
      borderBottom: "1px solid rgba(255,255,255,.09)",
    },
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
    },
    text: "",
  },
  light: {
    bar: {
      background: "linear-gradient(90deg, rgba(99,102,241,.10), rgba(34,211,238,.06))",
      borderBottom: "1px solid rgba(0,0,0,.08)",
    },
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
    },
    text: "",
  },
};

/* ============================== 极简 Mono ============================== */
/** 无底色、无图标、细点分隔。给不想被打扰的重度用户。 */
const MONO: Record<Theme, StatusbarSkin> = {
  dark: {
    bar: { background: "transparent", borderBottom: "1px solid rgba(255,255,255,.06)" },
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
    },
    text: "",
  },
  light: {
    bar: { background: "transparent", borderBottom: "1px solid rgba(0,0,0,.07)" },
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
    bar: { background: "#0a0f0a", borderBottom: "1px solid #1b2a1b" },
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
    },
    text: "",
  },
  light: {
    bar: { background: "#efe9da", borderBottom: "1px solid #d8cfb8" },
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
    },
    text: "",
  },
};

/* ============================== 高对比 ============================== */
/** 实心色块 + 深/浅反色字，对比度最高。弱光、投影、无障碍场景。 */
const CONTRAST: Record<Theme, StatusbarSkin> = {
  dark: {
    bar: { background: "#101216", borderBottom: "1px solid #3a4050" },
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
    },
    text: "#0b0d11",
  },
  light: {
    bar: { background: "#ffffff", borderBottom: "1px solid #3a4050" },
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
 * **ident 之后的全部内容**（含第一个 `;`），与 ident 本身无关。
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
 * 探针：判断远端是不是 bash/zsh。
 *
 * WHY 要先探再注入：注入串是 bash/zsh 语法，直接发给 fish / csh 会当场语法报错，
 * 在用户屏幕上留一段垃圾输出。探针只输出一条 OSC（被前端吞掉，屏幕上什么都没有），
 * 收不到回执就说明不是 bash/zsh，直接放弃注入——**绝不盲发**。
 *
 * 注意 `$0` 在登录 shell 下通常是 `-bash` / `-zsh`，够用来分辨。
 */
export const PROBE_CMD = `printf '\\033]1337;Shell=%s\\007' "$0"`;

/**
 * 提示符钩子（bash 走 PROMPT_COMMAND，zsh 走 precmd_functions）。
 *
 * 设计取舍，改动前请三思：
 *
 * 1. **只读取、不修改画面**：钩子只 printf 三条 OSC，不改 PS1、不写任何文件、
 *    不动 .bashrc/.zshrc。改 PS1 是另一量级的侵入，产品上明确不做。
 * 2. **git 分支按目录缓存**：`git rev-parse` 每次提示符都跑会拖慢手感（大仓库几十毫秒），
 *    所以只在 `$PWD` 变化时重跑。这正是 Starship「每段独立探测 + 缓存」的做法。
 * 3. **不做命令耗时**：那需要 bash 的 DEBUG trap / zsh 的 preexec 再多加一条序列，
 *    而 DEBUG trap 在钩子函数内部也会被触发，得用标志位过滤，脆弱且易误报。
 *    收益（一个 ⏱ 段）不值得这个风险，故只做路径 / 分支 / 退出码三段。
 */
export const HOOK_CMD = [
  `__ccb_p(){`,
  `local e=$?;`,
  `local d="$PWD";`,
  `printf '\\033]133;D;%s\\007\\033]7;file://%s%s\\007' "$e" "$HOSTNAME" "$d";`,
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
