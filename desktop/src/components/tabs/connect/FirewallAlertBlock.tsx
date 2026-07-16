import { useState } from "react";
import { invoke } from "../../../lib/tauri";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { copyText } from "../../../lib/utils";
import { CommandBlock } from "./widgets";

/**
 * 防火墙规则级告警块：仅「防火墙开 + 未放行 7823」时渲染。
 * 提供「一键开放（UAC 提权）」+「手动 netsh 命令」+「远程自检命令」，并支持「重新检查」。
 */
export function FirewallAlertBlock({
  port,
  onRefresh,
}: {
  port: number;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  // H6 修复：之前未 await/catch，无论剪贴板是否真正写入成功都会无条件提示"已复制"。
  const copyCmd = (cmd: string, label: string) => {
    if (!cmd) return;
    void copyText(
      cmd,
      () => toast(`${label}已复制到剪贴板`, "success"),
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  const open = async () => {
    setBusy(true);
    try {
      await invoke("open_firewall_port");
      toast("已在 UAC 弹窗中请求开放端口 " + port, "success");
      onRefresh();
    } catch (e) {
      // 用户取消 UAC 或提权失败：明确提示，不静默
      toast(`开放失败：${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    try {
      await invoke("refresh_firewall");
      onRefresh();
      toast("已重新检查防火墙状态", "success");
    } catch (e) {
      toast(`检查失败：${String(e)}`, "error");
    }
  };

  const manualCmd = `netsh advfirewall firewall add rule name=cc-bridge dir=in action=allow protocol=TCP localport=${port}`;
  const healthCmd = `curl http://<本机IP>:${port}/health`;

  return (
    <div className="animate-fade-in space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-warning/15 text-warning">
          <Icon name="shield" size={15} />
        </div>
        <div>
          <p className="text-sm font-semibold text-warning">远程可能无法连入：防火墙未放行端口 {port}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            本机 Windows 防火墙已开启，但未对 <code className="rounded bg-background px-1">{port}/TCP</code> 添加入站允许规则。远程服务器上的 Claude Code 发来的入站请求会被拦截，导致连接失败（即使本地服务正常运行）。
          </p>
        </div>
      </div>
      <div className="pl-[38px] flex flex-wrap items-center gap-2">
        <Button variant="default" size="sm" onClick={open} isLoading={busy} loadingText="请确认 UAC…">
          <Icon name="shield" size={14} />
          一键开放防火墙端口（{port}）
        </Button>
        <Button variant="outline" size="sm" onClick={recheck} disabled={busy}>
          <Icon name="refresh" size={14} />
          重新检查
        </Button>
        <span className="text-xs text-muted-foreground">点击后弹出系统 UAC 授权框，确认即写入入站规则。</span>
      </div>
      <div className="pl-[38px] space-y-1.5">
        <p className="text-xs text-muted-foreground">或手动在管理员终端执行：</p>
        <CommandBlock command={manualCmd} copied={false} onCopy={() => copyCmd(manualCmd, "命令")} />
        <p className="text-xs text-muted-foreground">在远程服务器上验证连通（返回 {"{"}"status":"ok"{"}"} 即可用该 IP）：</p>
        <CommandBlock command={healthCmd} copied={false} onCopy={() => copyCmd(healthCmd, "命令")} />
      </div>
    </div>
  );
}
