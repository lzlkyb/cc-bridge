import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { SettingsRow } from "../../ui/SettingsRow";
import { ToggleRow } from "../../ui/ToggleRow";
import { OptionChip } from "../../ui/OptionChip";
import { InlineNotice } from "../../ui/notice";
import {
  useTerminalInject,
  useTerminalPreset,
  useTerminalTmuxBridge,
} from "../../../hooks/useTerminalPreset";
import { useTerminalThemeSetting } from "../../../hooks/useTerminalAppearance";
import {
  PRESETS,
  setInjectEnabled,
  setPreset,
  setTmuxBridgeEnabled,
} from "../../../lib/terminalPreset";
import { TERMINAL_MODES, setTerminalMode } from "../../../lib/terminalAppearance";
import { TerminalFontOptions } from "./TerminalFontOptions";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  clampFontSize,
  loadFontSize,
  saveFontSize,
  subscribeFontSize,
} from "../../../lib/terminalFontSize";
import {
  TUI_SCROLL_SPEEDS,
  loadTuiScrollSpeed,
  saveTuiScrollSpeed,
} from "../../../lib/terminalScrollSpeed";
import {
  SCROLLBACK_OPTIONS,
  loadScrollback,
  saveScrollback,
  subscribeScrollback,
} from "../../../lib/terminalScrollback";

/**
 * 「终端」卡：外观（明暗 / 风格 / 字体 / 字号）+ 两项远端探测开关 + TUI 滚动速度。
 *
 * WHY 单独成卡而不是塞进「高级」：这些都是**会反复回来看一眼**的项（换环境、投影、夜间），
 * 而「高级」那张卡是「装完很少再动」的四项，两者改动频率不同，混在一起会被埋掉。
 *
 * WHY 走 localStorage 而非后端 config：见 `lib/terminalPreset.ts` 顶部注释。
 * 代价是它们不进备份/恢复——偏好丢了会回到默认值，不影响功能。
 *
 * 「明暗」与「风格」是**正交**的两轴：明暗管底色深浅（可脱离应用主题独立选），
 * 风格管配色语言（靖蓝 / 极简 / 经典 / 高对比）。两者相乘才是最终观感。
 */
export function TerminalGroup() {
  const preset = useTerminalPreset();
  const modeSetting = useTerminalThemeSetting();
  const inject = useTerminalInject();
  const tmuxBridge = useTerminalTmuxBridge();
  const [speed, setSpeed] = useState(loadTuiScrollSpeed);
  const [size, setSize] = useState(loadFontSize);
  const [scrollback, setScrollback] = useState(loadScrollback);
  // 字号可能在终端上用 Ctrl+滚轮改过，这里要跟着变，否则设置页会显示一个陈旧值。
  useEffect(() => subscribeFontSize(setSize), []);
  useEffect(() => subscribeScrollback(setScrollback), []);

  // 保存回声（2026-10-17，审查 #18）：本卡全部设置走 localStorage（见 lib/terminalPreset.ts
  // 顶部注释），**不适用 useSettingSave**——那套封装的是 save_config invoke，接上来会把
  // 终端偏好错误地写进后端配置。行内「已保存」复用同一个 SavedHint 视觉（SettingsRow/
  // ToggleRow 的 saved prop），回声定时器本组自记；卸载后清理（与 useSettingSave 同款纪律）。
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );
  const echo = (key: string) => {
    setSavedKey(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1500);
  };

  return (
    <Card id="set-terminal">
      <CardHeader>
        <CardTitle icon={<Icon name="terminal" />}>终端</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsRow
          label="终端明暗"
          sub="应用与终端配色互不影响"
          info={
            <>
              终端画布单独选深浅，与应用界面的明暗互不影响（例如应用浅色 + 终端深色）。改动即时生效，不重连、不丢已滚动的历史输出。
              <br />
              注意：正在运行的全屏程序（如 Claude Code）只在启动时探测一次背景明暗，需要重启它才会用上新配色。
            </>
          }
          layout="stack"
          saved={savedKey === "t-mode"}
          control={
            <div className="flex flex-wrap gap-1.5 pt-1">
              {TERMINAL_MODES.map((m) => (
                <OptionChip
                  key={m.id}
                  on={modeSetting === m.id}
                  onClick={() => {
                    setTerminalMode(m.id);
                    echo("t-mode");
                  }}
                >
                  {m.name}
                </OptionChip>
              ))}
            </div>
          }
        />
        <SettingsRow
          label="终端风格"
          info={
            <>
              决定配色语言（终端内容与状态栏的 ANSI 配色）。底色深浅由上面「终端明暗」决定，这里只换风格。切换即时生效，不会重连，也不会丢失已滚动的历史输出。
            </>
          }
          layout="stack"
          saved={savedKey === "t-preset"}
          control={
            <div className="flex flex-wrap gap-1.5 pt-1">
              {PRESETS.map((p) => (
                <OptionChip
                  key={p.id}
                  on={preset === p.id}
                  onClick={() => {
                    setPreset(p.id);
                    echo("t-preset");
                  }}
                >
                  {p.name}
                </OptionChip>
              ))}
            </div>
          }
        />
        <TerminalFontOptions />
        <SettingsRow
          label="终端字号"
          sub="也可在终端上 Ctrl+滚轮缩放"
          saved={savedKey === "t-size"}
          control={
            <div className="flex items-center gap-1.5">
              <SizeButton
                label="减小字号"
                disabled={size <= FONT_SIZE_MIN}
                onClick={() => {
                  saveFontSize(clampFontSize(size - 1));
                  echo("t-size");
                }}
              >
                −
              </SizeButton>
              <span className="w-9 text-center text-[13px] tabular-nums">{size}</span>
              <SizeButton
                label="增大字号"
                disabled={size >= FONT_SIZE_MAX}
                onClick={() => {
                  saveFontSize(clampFontSize(size + 1));
                  echo("t-size");
                }}
              >
                +
              </SizeButton>
            </div>
          }
        />
        <SettingsRow
          label="回滚缓冲"
          sub="5000 行约占 12 MB 内存/会话"
          info={
            <>
              保留多少行可往上翻的历史输出。跑构建日志、tail 大文件选大一点。改动即时生效：调大会扩容，调小从最旧的开始裁，不重连不断会话。行数有内存代价（5000 行约 12 MB/会话）。
            </>
          }
          layout="stack"
          saved={savedKey === "t-sb"}
          control={
            <div className="flex flex-wrap gap-1.5 pt-1">
              {SCROLLBACK_OPTIONS.map((n) => (
                <OptionChip
                  key={n}
                  on={scrollback === n}
                  onClick={() => {
                    saveScrollback(n);
                    echo("t-sb");
                  }}
                >
                  {n >= 10000 ? `${n / 10000} 万行` : `${n} 行`}
                </OptionChip>
              ))}
            </div>
          }
        />
        <ToggleRow
          label="远端路径/分支探测"
          sub="只读取远端目录与分支，不写文件"
          info={
            <>
              会话连上后向远端 shell 注入一段轻量钩子，读取当前目录与 git 分支显示在状态栏。只读取、不改提示符、不写任何文件；远端非 bash/zsh 或注入失败时自动降级。关掉后状态栏只显示本地可算的信息。
            </>
          }
          checked={inject}
          onChange={(v) => {
            setInjectEnabled(v);
            echo("t-inject");
          }}
          saved={savedKey === "t-inject"}
        />
        <ToggleRow
          label="tmux 桥接"
          sub="影响主机上全部 tmux 会话"
          info={
            <>
              会话检测到远端跑在 tmux 里时，注入三行 tmux 全局设置，让桌面通知、进度条、Shift+Enter 换行与 OSC 52 复制能穿透到外层终端。
              <br />
              <b className="text-warning-ink">注意：</b>
              这是对运行中 tmux server 的全局设置，会影响同一台机器上你的其它 tmux 会话；在共享主机上请确认后再开。新开或重连的会话生效。
            </>
          }
          checked={tmuxBridge}
          onChange={(v) => {
            setTmuxBridgeEnabled(v);
            echo("t-tmux");
          }}
          saved={savedKey === "t-tmux"}
        />
        <SettingsRow
          label="TUI 滚动速度"
          sub="拖动一步滚几行；对话长选 3–5 更省手"
          info={
            <>
              「TUI 滚动」状态下拖动滚动条的速度：拖动一个字高的距离对应几行内容。1 = 精细跟手；对话很长时选 3 或 5 更省手。改动即时生效，正在拖动的滚动条下一次移动就用新值。
            </>
          }
          layout="stack"
          saved={savedKey === "t-speed"}
          control={
            <div className="flex flex-wrap gap-1.5 pt-1">
              {TUI_SCROLL_SPEEDS.map((v) => (
                <OptionChip
                  key={v}
                  on={speed === v}
                  onClick={() => {
                    saveTuiScrollSpeed(v);
                    setSpeed(v);
                    echo("t-speed");
                  }}
                >
                  {v} 行
                </OptionChip>
              ))}
            </div>
          }
        />
        <InlineNotice variant="info" className="mt-3">
          进入 Claude Code 等全屏程序时，滚动条会自动切换为「TUI 滚动」：拖动它直接滚动程序里的内容（如对话），拖到顶/底跳到最早/最新。若你更想用终端原生回滚看完整历史，可在
          Claude Code 里运行 <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[11.5px]">/tui default</code>，对话会回到普通缓冲区。
        </InlineNotice>
      </CardContent>
    </Card>
  );
}

/** 字号步进按钮。到边界时禁用（而不是点了没反应），边界值来自 lib/terminalFontSize。 */
function SizeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 rounded-md border border-border bg-card text-[13px] leading-none transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
