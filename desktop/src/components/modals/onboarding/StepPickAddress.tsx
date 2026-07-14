import { useState } from "react";
import type { StatusResponse } from "../../../lib/types";
import { buildDisplayHost, buildHealthCheck, ipHint } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

/**
 * 引导第 2 步：选择远程服务器能连回本机的地址。
 * 复用 ConnectTab 的 ipHint 与 buildHealthCheck，给出「到服务器上验证哪个通」的命令。
 */
export function StepPickAddress({
  status,
  selectedIp,
  onSelectIp,
}: {
  status?: StatusResponse;
  selectedIp: string;
  onSelectIp: (ip: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const lanIps = status?.lanIps ?? [];
  const port = status?.port ?? 7823;
  // 用户还没点选时，用第一个网卡 IP 作为兜底展示，避免连通验证命令显示 127.0.0.1。
  const effectiveIp = selectedIp || lanIps[0] || "";
  const displayHost = buildDisplayHost(status, effectiveIp);
  const healthCheck = buildHealthCheck(displayHost, port);

  const copy = () => {
    if (!healthCheck) return;
    navigator.clipboard.writeText(healthCheck);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        在远程 Linux 上执行连接命令时，要通过下面某个地址连回本机。选错了 Claude Code 会连不上——拿不准就先选默认的，或到服务器上用下方命令逐个试。
      </p>

      <div>
        <p className="mb-2 text-sm font-medium">选择远程服务器能连回本机的地址</p>
        {lanIps.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-center text-sm text-muted-foreground">
            暂未检测到可用网络地址，请检查本机网络连接后重试。
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {lanIps.map((ip, i) => {
              const sel = selectedIp === ip;
              return (
                <button
                  key={ip}
                  onClick={() => onSelectIp(ip)}
                  className={`relative rounded-md border-2 px-3 py-2 text-left transition-colors ${
                    sel
                      ? "border-primary bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_14%,transparent)]"
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
                    {i === 0 && <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px]">默认</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{ipHint(ip)}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          在服务器上执行以下命令验证连通（返回 <code className="rounded bg-background px-1">{`{"status":"ok"}`}</code> 即该地址可用）：
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border bg-background px-3 py-2 text-xs font-mono">
            {healthCheck || "加载中..."}
          </code>
          <Button variant="outline" size="sm" className="shrink-0" onClick={copy} disabled={!healthCheck}>
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </div>
    </div>
  );
}
