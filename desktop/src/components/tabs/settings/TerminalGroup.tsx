import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { SettingsRow } from "../../ui/SettingsRow";
import { ToggleRow } from "../../ui/ToggleRow";
import { OptionChip } from "../../ui/OptionChip";
import { useTerminalPreset, useTerminalInject } from "../../../hooks/useTerminalPreset";
import { PRESETS, setPreset, setInjectEnabled } from "../../../lib/terminalPreset";

/**
 * 「终端」卡：终端风格预设。
 *
 * WHY 单独成卡而不是塞进「高级」：风格是**会反复回来看一眼**的项（换环境、投影、夜间），
 * 而「高级」那张卡是「装完很少再动」的四项，两者改动频率不同，混在一起会被埋掉。
 *
 * WHY 这两项走 localStorage 而非后端 config：见 `lib/terminalPreset.ts` 顶部注释。
 * 代价是它不进备份/恢复——偏好丢了会回到默认预设，不影响功能。
 */
export function TerminalGroup() {
  const preset = useTerminalPreset();
  const inject = useTerminalInject();
  return (
    <Card id="set-terminal">
      <CardHeader>
        <CardTitle icon={<Icon name="terminal" />}>终端</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsRow
          label="终端风格"
          sub="同时决定状态栏与终端内容的配色，包括远端程序输出的 ANSI 颜色。切换即时生效，不会重连，也不会丢失已滚动的历史输出。"
          layout="stack"
          control={
            <div className="flex flex-wrap gap-1.5 pt-1">
              {PRESETS.map((p) => (
                <OptionChip key={p.id} on={preset === p.id} onClick={() => setPreset(p.id)}>
                  {p.name}
                </OptionChip>
              ))}
            </div>
          }
        />
        <ToggleRow
          label="远端路径/分支探测"
          sub="会话连上后向远端 shell 注入一段轻量钩子，读取当前目录与 git 分支显示在状态栏。只读取、不改提示符、不写任何文件；远端非 bash/zsh 或注入失败时自动降级。关掉后状态栏只显示本地可算的信息。"
          checked={inject}
          onChange={setInjectEnabled}
          last
        />
      </CardContent>
    </Card>
  );
}
