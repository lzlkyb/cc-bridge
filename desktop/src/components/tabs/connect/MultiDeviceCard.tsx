import { useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import { copyText } from "../../../lib/utils";
import { invokeOrToast } from "../../../lib/tauri";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { useToast } from "../../ui/toast";

/**
 * 连接页「多设备接入模式」卡（opt-in，2026-10-17 设计稿 ④ + ①）。
 *
 * 🔴 兼容性契约：开关关闭（默认）时本卡只渲染开关行本身，不出现任何「本机身份」
 * UI，接入命令保持既有 sed 形态逐字不变——老用户升级感知为零。开启后才出现
 * 身份卡，且接入/更新命令在全链路（向导 / 横幅 / 托盘 / 命令面板）换条目级形态。
 *
 * 多设备语义：条目名 cc-bridge-<deviceId>（本机身份尾号），两台机器的条目在远端
 * 配置中并存、互不覆盖，把「互踢」变成「并存 + 显式切换」（AI 侧 /mcp 选条目）。
 * 接入命令固定 user 作用域——project 级配置跟随目录走，天然按机器隔离。
 */
export function MultiDeviceCard({
  status,
  onChanged,
}: {
  status?: StaticStatus;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const enabled = !!status?.multiDeviceMode;
  // 复制身份的内联反馈（2s 自动回滚），与全站复制反馈口径一致。
  const [copied, setCopied] = useState(false);

  const toggle = (next: boolean) => {
    // 🔴 save_config 的形参名为 patch，必须包进 { patch: {...} }，平铺静默不落盘。
    void invokeOrToast("save_config", { patch: { multiDeviceMode: next } }).then(onChanged);
  };

  const copyIdentity = () => {
    const text = `${status?.deviceName ?? "PC"} #${status?.deviceId ?? ""}`;
    void copyText(
      text,
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => toast("复制失败，请手动复制", "error"),
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <ToggleRow
        label="多设备接入模式"
        sub={enabled ? "已开启：接入命令为独立条目，可与其它设备并存" : "为这台电脑生成独立条目名的接入命令，与其它设备并存、互不覆盖"}
        info={
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
        }
        checked={enabled}
        onChange={toggle}
        last
      />

      {enabled && (
        <div className="mt-1 flex items-center gap-2.5 border-t pt-3.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-foreground">
              本机身份：{status?.deviceName || "PC"}{" "}
              <span className="font-mono text-xs text-muted-foreground">#{status?.deviceId || "…"}</span>
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              条目名 <code className="rounded bg-muted px-1">cc-bridge-{status?.deviceId || "…"}</code>
              ，双机冲突时可凭尾号分辨「现在接的是谁」。
            </div>
          </div>
          <button
            type="button"
            onClick={copyIdentity}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon name={copied ? "check" : "copy"} size={13} />
            {copied ? "已复制" : "复制身份"}
          </button>
        </div>
      )}
    </div>
  );
}
