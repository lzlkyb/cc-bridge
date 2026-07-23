import { useState } from "react";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { ipHint, copyText } from "../../../lib/utils";
import { useToast } from "../../ui/toast";

/** 多网卡时让用户选「远程服务器能连回本机的地址」，并附连通自检命令 */
export function AddressPicker({
  ips,
  selected,
  onSelect,
  healthCheck,
  onRefresh,
}: {
  ips: string[];
  selected: string;
  onSelect: (ip: string) => void;
  healthCheck: string;
  onRefresh?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { toast } = useToast();
  // H6 修复：之前未 await/catch，剪贴板权限被拒绝时会出现"显示已复制但其实没复制"。
  const copyHealth = () => {
    if (!healthCheck) return;
    void copyText(
      healthCheck,
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">选择远程服务器能连回本机的地址</p>
          <p className="text-xs text-muted-foreground mt-1">
            <Icon name="plug" size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" /> 通过 <b>VPN</b> 连服务器 → 选 VPN 网段（多为 10.x）；
            <Icon name="monitor" size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" /> <b>内网直连</b> → 选内网 IP（192.168.x / 172.x）。
            拿不准就逐个试，或用下方命令在服务器上验证哪个通。
          </p>
        </div>
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setRefreshing(true);
              onRefresh();
              setTimeout(() => setRefreshing(false), 800);
            }}
          >
            <Icon name="refresh" size={14} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "刷新中" : "刷新地址"}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {ips.map((ip, i) => {
          const sel = selected === ip;
          return (
            <button
              key={ip}
              onClick={() => onSelect(ip)}
              className={`relative rounded-md border-2 px-3 py-2 text-left transition-colors ${
                sel
                  ? "border-primary bg-accent shadow-ring-focus"
                  : "border-transparent bg-background hover:bg-muted"
              }`}
            >
              {sel && (
                <span className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Icon name="check" size={10} />
                </span>
              )}
              <div className="flex items-center gap-2">
                <code className={`text-sm font-mono ${sel ? "text-primary" : ""}`}>{ip}</code>
                {i === 0 && <Badge variant="secondary">默认</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{ipHint(ip)}</p>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 pt-1">
        <p className="text-xs text-muted-foreground">
          在服务器上执行以下命令验证连通（返回 {"{"}"status":"ok"{"}"} 即可用该 IP）：
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-background border px-3 py-2 text-xs font-mono">
            {healthCheck}
          </code>
          <Button variant="outline" size="sm" className="shrink-0" onClick={copyHealth} disabled={!healthCheck}>
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </div>
    </div>
  );
}
