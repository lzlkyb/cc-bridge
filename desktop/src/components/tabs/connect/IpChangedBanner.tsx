import { useState } from "react";
import { Icon } from "../../ui/icon";
import { McpScope, copyText } from "../../../lib/utils";
import { CommandBlock } from "./widgets";
import { useToast } from "../../ui/toast";

/**
 * 地址变化醒目 banner：仅 status.ipChanged 为真（或 ipResolvedByUser 兜底）时渲染。
 * 确认选中新 IP 并复制命令后，onResolved 会重新落盘 last_selected_ip，下一次轮询
 * ip_changed 回为 false，banner 自行消失。
 */
export function IpChangedBanner({
  lanIps,
  selectedIp,
  previousIp,
  port,
  scope,
  projectPath,
  onResolved,
  onSedResolved,
  onDismiss,
}: {
  lanIps: string[];
  selectedIp: string;
  previousIp: string | null;
  port: number;
  scope: McpScope;
  projectPath: string;
  onResolved: (ip: string) => void;
  onSedResolved: () => void;
  onDismiss?: () => void;
}) {
  const [copiedCmd, setCopiedCmd] = useState("");
  const { toast } = useToast();

  // 网卡全部消失时，下方选择控件与确认按钮会永久 disabled 形成死局。
  // 此时只给说明、不渲染选择控件；网络恢复、网卡重新出现后会自动回到正常分支。
  if (lanIps.length === 0) {
    return (
      <div className="animate-fade-in relative space-y-3 rounded-lg border border-destructive/35 bg-destructive/[0.08] p-4">
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="关闭提示"
            title="本次会话忽略此提示"
            className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-foreground"
          >
            <Icon name="close" size={14} />
          </button>
        )}
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
            <Icon name="alertTriangle" size={15} />
          </div>
          <div>
            <p className="text-sm font-semibold text-destructive">检测到网络地址变化</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              之前使用的 <code className="rounded bg-background px-1">{previousIp ?? "原地址"}</code> 已不在本机网卡列表中,且当前没有任何可用的网络地址。请检查网络连接,恢复后本应用将自动重新检测并更新连接命令。
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 原地替换 url 里的 host：sed 匹配任意旧 IP（[0-9.]*），幂等可重跑，
  // 不动 Bearer、不 remove+add，因此服务器条目与授权状态保留、不会重新授权。
  // 作用域直接读下方选择卡当前选中的 scope（方案 A：实时联动），始终输出单条精确命令。
  const buildSed = (scp: "user" | "project") => {
    const cfgFile = scp === "user" ? "~/.claude.json" : ".mcp.json";
    const cdPrefix =
      scp === "project" && projectPath.trim() ? `cd "${projectPath.trim()}" && ` : "";
    return `${cdPrefix}sed -i 's#http://[0-9.]*:${port}/mcp#http://${selectedIp}:${port}/mcp#g' ${cfgFile}`;
  };

  const entries: { label: string; cmd: string }[] = [
    {
      label: scope === "user" ? "全局（~/.claude.json）" : "项目（.mcp.json）",
      cmd: buildSed(scope),
    },
  ];

  // 仅当用户已在下方 AddressPicker 选中一个当前在网卡列表中的「新」地址时，
  // 才允许生成/复制 sed（把远程配置里的旧 IP 替换为选中的新 IP）。
  // selectedIp 为空或仍是已消失的旧地址时，sed 无意义，禁用复制。
  const newIpValid = !!selectedIp && lanIps.includes(selectedIp);

  // H6 修复：之前未 await/catch，剪贴板写入失败时仍会调 onResolved/onSedResolved 让 banner 消失，用户其实
  // 没拿到更新命令却以为已处理完。现只在真正复制成功后才收口。
  const copyOne = (cmd: string) => {
    if (!cmd || !newIpValid) return;
    void copyText(
      cmd,
      () => {
        setCopiedCmd(cmd);
        onResolved(selectedIp);
        onSedResolved(); // 收口——复制远程更新命令后允许 banner 自然消失
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  return (
    <div className="animate-fade-in relative space-y-3 rounded-lg border border-destructive/35 bg-destructive/[0.08] p-4">
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          title="本次会话忽略此提示"
          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-foreground"
        >
          <Icon name="close" size={14} />
        </button>
      )}
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
          <Icon name="alertTriangle" size={15} />
        </div>
        <div>
          <p className="text-sm font-semibold text-destructive">检测到网络地址变化</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              之前使用的 <code className="rounded bg-background px-1">{previousIp}</code> 已不在本机网卡列表中（大概率是
              网络重新连接后分配了新地址）。请在下方「选择远程服务器能连回本机的地址」中选中新地址，连接命令会自动更新，复制后到远程服务器执行即可原地更新 IP（无需重新授权）。
            </p>
        </div>
      </div>

      {newIpValid ? (
        <div className="pl-[38px] space-y-3">
          <p className="text-xs text-muted-foreground">
            已选中新地址，复制以下命令到远程服务器执行（原地更新 IP，不会重新授权）：
          </p>
          {entries.map((e, i) => (
            <div key={i} className="space-y-1.5">
              <p className="text-xs font-medium text-foreground/80">{e.label}</p>
              <CommandBlock
                command={e.cmd}
                copied={copiedCmd === e.cmd}
                onCopy={() => copyOne(e.cmd)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="pl-[38px] text-xs text-muted-foreground">
          在下方选一个新地址后，这里会自动生成「原地更新 IP」的远程命令。
        </p>
      )}
    </div>
  );
}
