import { useEffect, useRef, useState } from "react";
import { copyText } from "../../../lib/utils";
import { Icon } from "../../ui/icon";
import { Switch } from "../../ui/switch";
import { InfoPopover } from "../../ui/InfoPopover";
import { useToast } from "../../ui/toast";

/**
 * 接入卡标题行内的「多设备接入模式」紧凑开关（2026-10-18 从页底 MultiDeviceCard 迁来）。
 *
 * 为什么搬：多设备决定的是接入命令的形态（条目级 vs 全局 sed），开关却住在页底
 * 独立卡——用户在向导里复制命令时看不到它，命令形态变了也无从归因。贴到命令的
 * 产出地（四工具共用的卡头）才符合因果。说明文字全部进 ⓘ（InfoPopover），
 * 标题行零文字负担；开启后旁边亮身份 chip，点按复制身份。
 *
 * 🔴 兼容性契约不变：开关默认关；关闭（默认）态所有接入/更新命令逐字保持既有
 * sed 形态——本组件只是 UI 位置迁移，不碰命令生成（真源在 Rust network.rs）。
 */
export function MultiDeviceToggle({
  enabled,
  deviceId,
  deviceName,
  onToggle,
}: {
  enabled: boolean;
  /** 本机身份尾号（4 位 hex）；空 = 尚未生成，chip 不渲染。 */
  deviceId: string;
  deviceName: string;
  onToggle: (next: boolean) => void;
}) {
  const { toast } = useToast();
  // 身份复制的内联反馈（2s 自动回滚），与全站复制反馈口径一致。
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copyIdentity = () => {
    void copyText(
      `${deviceName || "PC"} #${deviceId}`,
      () => {
        setCopied(true);
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 2000);
      },
      () => toast("复制失败，请手动复制", "error"),
    );
  };

  return (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">多设备</span>
      <Switch checked={enabled} onChange={onToggle} ariaLabel="多设备接入模式" />
      {enabled && !!deviceId && (
        <button
          type="button"
          onClick={copyIdentity}
          aria-live="polite"
          title={`本机身份：${deviceName || "PC"} #${deviceId}（点击复制）`}
          className="flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon name={copied ? "check" : "copy"} size={11} aria-hidden="true" />#{deviceId}
        </button>
      )}
      <InfoPopover label="多设备接入模式">
        <div className="space-y-1.5 text-xs leading-relaxed">
          <p>
            默认（单设备）模式下，接入命令按 URL 全局替换——两台电脑先后接入会互相覆盖，表现为「互踢」。
          </p>
          <p>
            开启后，接入产物按工具升级为条目级、条目名携带本机身份尾号
            （<code className="rounded bg-muted px-1">cc-bridge-xxxx</code>）：
            Claude Code 用 <code className="rounded bg-muted px-1">claude mcp remove/add</code> 命令；
            Codex / WorkBuddy 的接入片段与 IP 修复命令都只作用于本机尾号条目。各设备条目在远端配置中并存；
            在 AI 侧用 <code className="rounded bg-muted px-1">/mcp</code> 显式切换用哪台。
          </p>
          <p>
            Claude Code 接入命令固定为用户级（~/.claude.json）；重新生成令牌会同时断开所有设备——届时每台设备重新执行自己的接入命令即可。
          </p>
        </div>
      </InfoPopover>
    </div>
  );
}
