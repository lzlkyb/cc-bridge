import { useState } from "react";
import { Icon } from "../../ui/icon";
import { McpScope, copyText } from "../../../lib/utils";
import { ActionCard, InlineNotice } from "../../ui/notice";
import { CommandBlock } from "./widgets";
import { useToast } from "../../ui/toast";

/**
 * 地址变化通知（L3 ActionCard）：仅 status.ipChanged 为真（或 ipResolvedByUser 兜底）时渲染。
 * 确认选中新 IP 并复制命令后，onResolved 会重新落盘 last_selected_ip，下一次轮询
 * ip_changed 回为 false，banner 自行消失。
 *
 * 统一通知方案重设计（design/统一通知系统设计稿.html）：
 *  - 默认折叠为一行细条，摘要一句话说清「旧 IP → 新 IP · 复制即可原地修复」；
 *  - 细条上直接带「复制命令」按钮，免展开一步完成；复制后按钮变绿并 toast 确认；
 *  - 点细条其余区域展开详情（完整说明 + 命令块），展开重置 60s 倒计时环，到 0 自动收起
 *    （细条常驻不消失）；复制成功 / 点 × 仍按原逻辑收口 / 忽略；
 *  - 语义色改为琥珀警告（destructive 红只留给真正失败）。
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
      <div className="animate-fade-in relative">
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="关闭提示"
            title="本次会话忽略此提示"
            className="absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-foreground"
          >
            <Icon name="close" size={14} />
          </button>
        )}
        <InlineNotice variant="error" className="pr-8">
          <b>检测到网络地址变化</b>
          <br />
          之前使用的 <code className="rounded bg-background px-1">{previousIp ?? "原地址"}</code>{" "}
          已不在本机网卡列表中,且当前没有任何可用的网络地址。请检查网络连接,恢复后本应用将自动重新检测并更新连接命令。
        </InlineNotice>
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

  const cmdLabel = scope === "user" ? "全局（~/.claude.json）" : "项目（.mcp.json）";
  const cmd = buildSed(scope);

  // 仅当用户已在下方 AddressPicker 选中一个当前在网卡列表中的「新」地址时，
  // 才允许生成/复制 sed（把远程配置里的旧 IP 替换为选中的新 IP）。
  // selectedIp 为空或仍是已消失的旧地址时，sed 无意义，禁用复制。
  const newIpValid = !!selectedIp && lanIps.includes(selectedIp);

  // H6 修复：之前未 await/catch，剪贴板写入失败时仍会调 onResolved/onSedResolved 让 banner 消失，用户其实
  // 没拿到更新命令却以为已处理完。现只在真正复制成功后才收口。
  const copyOne = () => {
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
    <ActionCard
      tone="warning"
      title="网络地址已变化"
      pill="待处理"
      summary={
        newIpValid
          ? `${previousIp ?? "原地址"} → ${selectedIp} · 复制即可原地修复`
          : `${previousIp ?? "原地址"} 已失效 · 在下方选中新地址后可复制修复命令`
      }
      autoCollapseSec={60}
      copyLabel="复制命令"
      onCopy={copyOne}
      copyDisabled={!newIpValid}
      resolved={!!copiedCmd}
      onDismiss={onDismiss}
    >
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          之前使用的 <code className="rounded bg-background px-1 text-foreground">{previousIp}</code>{" "}
          已不在本机网卡列表中（大概率是网络重新连接后分配了新地址）。复制以下命令到远程服务器执行即可
          <b className="text-foreground">原地更新 IP，无需重新授权</b>；也可在下方「选择远程服务器能连回本机的地址」中换选其他地址。
        </p>
        {newIpValid ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground/80">{cmdLabel}</p>
            <CommandBlock command={cmd} copied={copiedCmd === cmd} onCopy={copyOne} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            在下方选一个新地址后，这里会自动生成「原地更新 IP」的远程命令。
          </p>
        )}
      </div>
    </ActionCard>
  );
}
