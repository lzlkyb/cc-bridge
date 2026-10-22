import type { ReactNode } from "react";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { OptionChip } from "../ui/OptionChip";
import { useTerminalPreset } from "../../hooks/useTerminalPreset";
import { useTerminalFontStack, useTerminalThemeSetting } from "../../hooks/useTerminalAppearance";
import { PRESETS, setPreset } from "../../lib/terminalPreset";
import { TERMINAL_PALETTES, type TerminalPreset } from "../../lib/terminalTheme";
import { TERMINAL_MODES, setTerminalMode } from "../../lib/terminalAppearance";
import { FONT_SAMPLE, FONT_STACKS, setFontId } from "../../lib/terminalFontFamily";
import { ButtonIcon } from "./SshTerminalMoreMenu";

/**
 * 终端「外观」快切菜单：工具条上那枚常驻的调色板按钮。
 *
 * 三段——**风格**（4 套预设）/ **明暗**（跟随应用 · 深色 · 浅色）/ **字体**（4 套等宽栈，
 * 全部开箱即用：JetBrains Mono / Fira Code 随安装包内置）。
 *
 * WHY 三段挤一个菜单而不是各给一个按钮：工具条右侧已有 8 个控件，再加会把中间
 * `truncate` 的连接名挤掉；而且这三件事本来就是同一类偏好——「终端长什么样」。
 * 拆成三个按钮是同义分裂。
 *
 * WHY 从 SshTerminalToolbar 抽出来单独成文件：那个文件已到 243 行（上限 300），
 * 塞进三段菜单必破线；抽出来顺带把原来的 PresetMenu + PresetSwatch 一并搬走。
 *
 * 🔴 字体项必须**用该字体自己渲染样例**：这是菜单里唯一能预览的机会。
 * 样例取 `FONT_SAMPLE`（`Ag 0O 1lI 中文,.`）——字形差异最大的组合，一行就能分辨五套字。
 */
export function TerminalAppearanceMenu() {
  return <Menu width="w-[300px]" trigger={(open, toggle) => (
    <ButtonIcon title="终端外观（风格 / 明暗 / 字体）" highlight={open} onClick={toggle}><Icon name="palette" size={14}/></ButtonIcon>
  )}>{close => <TerminalAppearanceOptions close={close}/>}</Menu>;
}

/** Shared options let the full-screen More menu drill into appearance without opening a second menu. */
export function TerminalAppearanceOptions({close}: {close: () => void}) {
  const preset = useTerminalPreset();
  const modeSetting = useTerminalThemeSetting();
  const fontStack = useTerminalFontStack();

  return (
    <>
          <GroupLabel>风格</GroupLabel>
          {PRESETS.map((p) => (
            <MenuItem
              key={p.id}
              active={preset === p.id}
              onClick={() => {
                setPreset(p.id);
                close();
              }}
              trailing={
                preset === p.id ? <Icon name="check" size={13} className="text-primary" /> : null
              }
              label={<PresetRow preset={p.id} name={p.name} desc={p.desc} />}
            />
          ))}

          <Divider />
          <GroupLabel>明暗</GroupLabel>
          {/* 点 chip **不关菜单**：连着试两种底色时能实时看到终端变化（菜单在右上角，不挡画布）。 */}
          <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5">
            {TERMINAL_MODES.map((m) => (
              <OptionChip
                key={m.id}
                on={modeSetting === m.id}
                onClick={() => setTerminalMode(m.id)}
              >
                {m.name}
              </OptionChip>
            ))}
          </div>

          <Divider />
          <GroupLabel>字体</GroupLabel>
          {FONT_STACKS.map((f) => (
            <MenuItem
              key={f.id}
              active={fontStack === f.stack}
              onClick={() => {
                setFontId(f.id);
                close();
              }}
              trailing={
                fontStack === f.stack ? (
                  <Icon name="check" size={13} className="text-primary" />
                ) : null
              }
              label={<FontRow stack={f.stack} name={f.name} />}
            />
          ))}
        </>
  );
}

/** 分组小标题。11 个平铺项没有分组会糊成一片，这一行是菜单能读的前提。 */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-border" />;
}

/** 风格项：小色板 + 名称 + 一句说明。色板用深色盘（四套预设的差异在深色下最好认）。 */
function PresetRow({ preset, name, desc }: { preset: TerminalPreset; name: string; desc: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <PresetSwatch preset={preset} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px]">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{desc}</span>
      </span>
    </span>
  );
}

/** 预设小色板预览：背景 + 几个代表 ANSI 色拼一行，一眼区分四套风格。 */
function PresetSwatch({ preset }: { preset: TerminalPreset }) {
  const pal = TERMINAL_PALETTES[preset].dark;
  const colors = [pal.background, pal.green, pal.cyan, pal.magenta, pal.yellow];
  return (
    <span
      className="flex shrink-0 overflow-hidden rounded border border-border"
      style={{ width: 22, height: 14 }}
    >
      {colors.map((c, i) => (
        <span key={i} style={{ background: c, flex: 1 }} />
      ))}
    </span>
  );
}

/**
 * 字体项：名称一行、样例一行（14px，该字体自己渲染——唯一的预览机会）。
 *
 * WHY 两行而不是「样例 + 名称」挤一行：各字体样例宽度不同，横排会让名称列参差
 * （实测观感差）；纵排后名称列天然对齐，菜单也更像「字体选择器」的样子。
 */
function FontRow({ stack, name }: { stack: string; name: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col leading-tight">
      <span className="truncate text-[13px]">{name}</span>
      <span className="truncate text-[14px] leading-snug" style={{ fontFamily: stack }}>
        {FONT_SAMPLE}
      </span>
    </span>
  );
}
