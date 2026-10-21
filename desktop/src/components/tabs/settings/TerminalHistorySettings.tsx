import { useEffect, useState } from "react";
import { SettingsRow } from "../../ui/SettingsRow";
import { ToggleRow } from "../../ui/ToggleRow";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useTerminalInject, useTerminalTmuxBridge } from "../../../hooks/useTerminalPreset";
import { setInjectEnabled, setTmuxBridgeEnabled } from "../../../lib/terminalPreset";
import { SCROLLBACK_OPTIONS, loadScrollback, saveScrollback, subscribeScrollback } from "../../../lib/terminalScrollback";
import { useTerminalSettingFeedback } from "./useTerminalSettingFeedback";

export function TerminalHistorySettings() {
  const [scrollback, setScrollback] = useState(loadScrollback);
  const [confirmTmux, setConfirmTmux] = useState(false);
  const inject = useTerminalInject();
  const tmux = useTerminalTmuxBridge();
  const feedback = useTerminalSettingFeedback();
  useEffect(() => subscribeScrollback(setScrollback), []);

  return <section className="terminal-settings-section" aria-labelledby="terminal-history-title">
    <h2 id="terminal-history-title">历史与集成</h2>
    <SettingsRow id="terminal-scrollback" label="回滚缓冲" sub="每会话 5000 行约占 12 MB；调小会裁剪最旧输出"
      info="改动即时生效，不重连。缓冲只保存在当前会话中，不是文件备份。"
      saved={feedback.isSaved("scrollback")} error={feedback.errorFor("scrollback")}
      control={<select className="terminal-settings-select" aria-label="回滚缓冲" value={scrollback}
        onChange={event => feedback.apply("scrollback", () => saveScrollback(Number(event.target.value)))}>
        {[...new Set([...SCROLLBACK_OPTIONS, scrollback])].sort((a, b) => a - b).map(n => <option key={n} value={n}>{n.toLocaleString()} 行</option>)}
      </select>} />
    <ToggleRow id="terminal-inject" label="远端路径/分支探测" sub="只读取远端目录与 Git 分支，不写文件"
      info="连上后向 bash/zsh 注入轻量提示符钩子，读取当前目录与分支。注入失败时自动降级；关闭后状态栏只显示本地可算的信息。"
      checked={inject} onChange={value => feedback.apply("inject", () => setInjectEnabled(value))}
      saved={feedback.isSaved("inject")} error={feedback.errorFor("inject")} />
    <ToggleRow id="terminal-tmux" label="tmux 桥接" sub="新开或重连生效；影响该主机上全部 tmux 会话" last
      info="会设置远端 tmux server 的 allow-passthrough、extended-keys 与 terminal-features，以支持通知、进度、Shift+Enter 与 OSC 52 复制。共享主机请先确认影响。"
      checked={tmux} onChange={value => value ? setConfirmTmux(true) : feedback.apply("tmux", () => setTmuxBridgeEnabled(false))}
      saved={feedback.isSaved("tmux")} error={feedback.errorFor("tmux")} />
    <ConfirmDialog open={confirmTmux} onCancel={() => setConfirmTmux(false)}
      title="启用 tmux 桥接？" description="新开或重连的会话将修改远端 tmux server 的全局设置，允许转义序列穿透；会影响同一主机上的其它 tmux 会话。请确认你有权修改该环境。"
      confirmLabel="确认启用" onConfirm={() => { feedback.apply("tmux", () => setTmuxBridgeEnabled(true)); setConfirmTmux(false); }} />
  </section>;
}
