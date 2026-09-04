import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { IconName } from "../ui/icon";
import { Icon } from "../ui/icon";
import {
  STATUSBAR_SKINS,
  formatUptime,
  shortenPath,
  type SegKind,
  type StatusbarSkin,
} from "../../lib/terminalStatusbar";
import type { TerminalStatus, OscState } from "../../hooks/useTerminalOsc";
import type { TerminalPreset } from "../../lib/terminalTheme";
import type { Theme } from "../../lib/theme";
import type { SshConnection } from "../../lib/types";
import { useAppHidden } from "../../lib/appVisibility";

interface Props {
  sessionId: string;
  conn: SshConnection;
  preset: TerminalPreset;
  mode: Theme;
  status: TerminalStatus;
  state: OscState;
  /** 会话已断开。断开后冻结时长并显示「已断开」，不再展示远端探测提示。 */
  closed: boolean;
}

/**
 * 终端状态栏：坐在工具栏与 xterm 画布之间的一行 Starship 风格模块化状态。
 *
 * 显示哪些段由**有没有数据**决定，不由用户配置决定 —— 用户只选风格（产品决策：
 * 内置几套预设，不要求用户手写 TOML）。钩子没生效时自动降级到「连接名 + 会话时长 + 提示」，
 * 一行也不空，但绝不假装自己有远端信息。
 *
 * 断开态单独处理：closed 时冻结时长、显示「已断开」，不再把 OSC 探测的 hint 当成状态。
 *
 * WHY 段色走内联 style 而不是 CSS 类：四套风格 × 亮/暗 = 8 套 token，
 * 写成 CSS 类就得往 `index.css` 里塞 8 个选择器块，改一处要翻两个文件。
 * token 集中在 `lib/terminalStatusbar.ts`，这里只做「取 token → 贴样式」。
 */
export function TerminalStatusBar({ sessionId, conn, preset, mode, status, state, closed }: Props) {
  const skin = STATUSBAR_SKINS[preset][mode];
  const uptime = useUptime(sessionId, closed);
  const host = conn.name || conn.host;

  return (
    <div
      className="flex shrink-0 items-center overflow-hidden px-3 py-1 text-[11px]"
      style={{ ...skin.bar }}
    >
      {/* 左：随远端信息增多而变长的段，空间不足时单独横向滚动（滚动条隐藏）。
          用 flex-1 + min-w-0 让它自适应，右侧关键段因此永不被挤出视口。 */}
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        <Seg skin={skin} kind="host" icon="server" title={`${conn.username}@${conn.host}:${conn.port}`} isFirst>
          {host}
        </Seg>
        {status.cwd !== null && (
          <Seg skin={skin} kind="path" icon="folder" title={status.cwd}>
            {shortenPath(status.cwd)}
          </Seg>
        )}
        {status.branch !== null && (
          <Seg skin={skin} kind="git" icon="gitBranch" title="git 分支">
            {status.branch}
          </Seg>
        )}
        {/* Starship 默认行为：退出码只在失败时显示，成功不占位置。 */}
        {status.exitCode !== null && status.exitCode !== 0 && <ExitSeg skin={skin} code={status.exitCode} />}
      </div>

      {/* 右：关键段（会话时长、状态提示）锁定在最右，绝不被挤出视口。 */}
      <span className="ml-3 flex shrink-0 items-center">
        <Seg skin={skin} kind="muted" icon="clock" title="会话时长">
          {formatUptime(uptime)}
        </Seg>
        {closed ? (
          <Seg skin={skin} kind="exitBad" icon="alertTriangle" title="会话已断开">
            已断开
          </Seg>
        ) : (
          state !== "ready" && (
            <Seg skin={skin} kind="muted" icon="alertTriangle" title={HINT_TITLE[state]}>
              {HINT_TEXT[state]}
            </Seg>
          )
        )}
      </span>
    </div>
  );
}

/** 非 ready 时右侧的提示文案。刻意区分「还没探到」「探过了但不支持」「终端没建好」，避免误导。 */
const HINT_TEXT: Record<OscState, string> = {
  pending: "正在探测…",
  ready: "",
  off: "远端探测已关闭",
  unsupported: "路径/git 不可用",
  termNotReady: "终端未就绪",
};

const HINT_TITLE: Record<OscState, string> = {
  pending: "正在判断远端 shell 类型，稍后显示路径与 git 分支",
  ready: "",
  off: "你在设置里关掉了远端提示符钩子，状态栏只显示本地可算的信息",
  unsupported: "远端不是 bash/zsh，或钩子未生效。终端本身不受影响",
  termNotReady: "终端组件尚未初始化，远端信息暂不可用。终端本身不受影响",
};

function ExitSeg({ skin, code }: { skin: StatusbarSkin; code: number }) {
  return (
    <Seg skin={skin} kind="exitBad" title="上一条命令失败">
      {skin.icons ? `✘ ${code}` : `exit ${code}`}
    </Seg>
  );
}

function Seg({
  skin,
  kind,
  icon,
  title,
  isFirst,
  children,
}: {
  skin: StatusbarSkin;
  kind: SegKind;
  icon?: IconName;
  title?: string;
  /** 首个段（host）之前不画分隔线，避免依赖 DOM 顺序的 nth-of-type 魔法。 */
  isFirst?: boolean;
  children: React.ReactNode;
}) {
  const style: CSSProperties = { ...skin.seg };
  if (skin.solid) {
    style.background = skin.colors[kind];
    style.color = skin.text;
  } else {
    style.color = skin.colors[kind];
  }
  return (
    <>
      {!isFirst && <Divider skin={skin} />}
      <span style={style} title={title}>
        {skin.icons && icon && <Icon name={icon} size={11} />}
        {children}
      </span>
    </>
  );
}

/**
 * 段间分隔：靖蓝/高对比用竖线（高对比是色块，靠 margin 分开，不再画线），
 * 极简用 `·`、经典用 `│`。首段之前不画 —— 由 Seg 的 `isFirst` 控制，不靠 CSS 选择器猜顺序。
 */
function Divider({ skin }: { skin: StatusbarSkin }) {
  if (skin.solid) return null;
  if (skin.divider === null) {
    return (
      <span
        aria-hidden
        className="h-3 w-px shrink-0"
        style={{ background: skin.dividerColor }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{ color: skin.dividerColor }}
    >
      {skin.divider}
    </span>
  );
}

/**
 * 会话时长（本地可算，钩子未生效时也能显示，是状态栏的保底信息）。
 *
 * 5 秒一跳：显示精度只到分钟/秒级，没必要每秒重渲染——多标签时每个终端都有一个定时器。
 *
 * 三个要点：
 * 1. 起点存模块级 Map（按 sessionId），组件重挂（切标签若改 unmount 复用）不会归零；
 * 2. 断开后冻结：closed 时停止计时并保持最后值，重连则从 0 重新计；
 * 3. 窗口不可见（收托盘 / 最小化）时停定时器，跟全项目其他轮询一致（v2.5.0 修过「后台刷新不停」）。
 */
// 会话起点（ms）：模块级，跨组件重挂稳定。条目数 ≈ 历史会话数，量级很小，不回收。
const SESSION_START = new Map<string, number>();

function useUptime(sessionId: string, closed: boolean): number {
  if (!SESSION_START.has(sessionId)) SESSION_START.set(sessionId, Date.now());
  const frozenRef = useRef<number | null>(null);
  const appHidden = useAppHidden();
  const [ms, setMs] = useState(() => Date.now() - (SESSION_START.get(sessionId) ?? Date.now()));

  useEffect(() => {
    if (closed) {
      // 冻结：保留最后显示值，不再随真实时间增长。
      frozenRef.current = Date.now() - (SESSION_START.get(sessionId) ?? Date.now());
      setMs(frozenRef.current);
      return;
    }
    // 从断开恢复：时长从 0 重新计。
    if (frozenRef.current !== null) {
      SESSION_START.set(sessionId, Date.now());
      frozenRef.current = null;
    }
    const start = () => SESSION_START.get(sessionId) ?? Date.now();
    const tick = () => setMs(Date.now() - start());
    tick();
    // 不可见：不启动定时器。值保持正确，可见时本 effect 重跑再恢复刷新。
    if (appHidden) return;
    const id = window.setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [sessionId, closed, appHidden]);

  return ms;
}
