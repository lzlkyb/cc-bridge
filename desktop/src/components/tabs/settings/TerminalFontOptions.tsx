import { Icon } from "../../ui/icon";
import { SettingsRow } from "../../ui/SettingsRow";
import { useTerminalFontStack } from "../../../hooks/useTerminalAppearance";
import { BUNDLED_FAMILIES } from "../../../lib/bundledFonts";
import {
  FONT_SAMPLE,
  FONT_STACKS,
  setFontId,
  type TerminalFont,
} from "../../../lib/terminalFontFamily";

/**
 * 「终端字体」整行：样例卡网格。
 *
 * WHY 从 TerminalGroup 抽成独立文件：单卡带样例/名称/说明三层信息，抽走整行两边
 * 都松快（原文件已贴体量门禁）。
 *
 * 🔴 全部预设**开箱即用**（JetBrains Mono / Fira Code 随安装包内置，见
 * `lib/bundledFonts.ts`；其余为 Windows 常见/自带）——没有「未安装」状态、
 * 没有下载入口，任何一张卡点了就能用。曾经的检测 + 下载引导已随内置化删除。
 */
export function TerminalFontOptions() {
  const fontStack = useTerminalFontStack();

  return (
    <SettingsRow
      label="终端字体"
      sub="全部预设开箱即用"
      info={
        <>
          只影响终端画布与状态栏。全部预设开箱即用：标「内置」的随安装包附带，其余为 Windows 自带或常见字体。切换后会自动重算行列并同步给远端，不重连、不丢滚动历史。全部是等宽字体栈并带中文回退——非等宽字体会让字符宽度对不上、整屏错位，所以不提供自由输入。样例里的 Ag / 0O / 1lI 是各字体字形差异最大、最容易混淆的组合，中文用于确认 2 格宽不回退。
        </>
      }
      layout="stack"
      control={
        <div className="grid grid-cols-2 gap-1.5 pt-1">
          {FONT_STACKS.map((f) => (
            <FontCard key={f.id} font={f} on={fontStack === f.stack} />
          ))}
        </div>
      }
    />
  );
}

/**
 * 字体选项卡。样例文本（`FONT_SAMPLE`）用**该字体自己**渲染：
 * `Ag 0O 1lI` 看字形差异，「中文」确认宽度回退，一行分辨五套字。
 */
function FontCard({ font, on }: { font: TerminalFont; on: boolean }) {
  // 「内置」徽标从打包 family 派生（栈首即打包字体），不在 UI 里硬编码预设 id
  const builtin = BUNDLED_FAMILIES.some((fam) => font.stack.startsWith(`"${fam}"`));
  return (
    <button
      type="button"
      onClick={() => setFontId(font.id)}
      aria-pressed={on}
      className={`flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
        on ? "border-primary/40 bg-primary/10" : "border-border bg-card hover:bg-muted"
      }`}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span
          className={`truncate text-[12.5px] leading-none ${on ? "text-primary" : "text-foreground"}`}
          style={{ fontFamily: font.stack }}
        >
          {FONT_SAMPLE}
        </span>
        {on && <Icon name="check" size={13} className="ml-auto shrink-0 text-primary" />}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span className="truncate text-xs text-muted-foreground">{font.name}</span>
        {builtin && (
          <span className="shrink-0 rounded bg-primary/10 px-1 text-[11px] leading-4 text-primary">
            内置
          </span>
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground/80">{font.desc}</span>
    </button>
  );
}
