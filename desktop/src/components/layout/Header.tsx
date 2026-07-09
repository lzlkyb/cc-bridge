import { useState, useEffect } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useUpdate } from "../../contexts/UpdateContext";

export function Header({
  status,
  onChanged,
}: {
  status?: StatusResponse;
  onChanged?: () => void;
}) {
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");
  const [busy, setBusy] = useState(false);
  const { status: updateStatus, update: updateInfo } = useUpdate();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const running = status?.running ?? true;

  const toggleServer = async () => {
    setBusy(true);
    try {
      await invoke(running ? "stop_mcp_server" : "start_mcp_server");
      // 启停后立刻刷新状态；后端 running 标志已同步更新。
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="app-header flex shrink-0 items-center justify-between border-b px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">cc-bridge</h1>
        {status && (
          <span className="version-badge rounded-md px-2 py-0.5 text-[11px] font-bold tracking-wide">
            v{status.version}
          </span>
        )}
        {/* 运行状态胶囊：运行=绿+脉冲，停止=灰 */}
        <span
          className={`status-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
            running
              ? "border-success/30 bg-success/10 text-success"
              : "border-border bg-muted text-muted-foreground"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full bg-current ${running ? "p-dot" : ""}`} />
          {!status ? "连接中" : running ? "运行中" : "已停止"}
        </span>

        {/* 安全状态小徽章：任意页可见 */}
        {status && !status.whitelistEnabled && (
          <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
            <Icon name="alertTriangle" size={11} />
            白名单关闭
          </span>
        )}
        {status?.ipChanged && (
          <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
            <Icon name="alertTriangle" size={11} />
            IP 已变化
          </span>
        )}
        {status?.readonlyMode && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
            <Icon name="lock" size={11} />
            只读
          </span>
        )}
        {status?.shellEnabled && (
          <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
            <Icon name="terminal" size={11} />
            命令执行已开启
          </span>
        )}
        {updateStatus === "available" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
            <Icon name="arrowUp" size={11} />
            有新版本{updateInfo ? ` v${updateInfo.version}` : ""}
          </span>
        )}
        {updateStatus === "ready" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
            <Icon name="check" size={11} />
            待重启
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* 启停按钮 */}
        {status && (
          <Button
            variant={running ? "outline" : "default"}
            size="sm"
            disabled={busy}
            onClick={toggleServer}
            className="gap-1.5"
          >
            <Icon name={running ? "pause" : "play"} size={14} />
            {busy ? "..." : running ? "停止服务" : "启动服务"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setDark(!dark)}
          aria-label={dark ? "切换浅色" : "切换深色"}
        >
          <Icon name={dark ? "sun" : "moon"} size={18} />
        </Button>
      </div>
    </header>
  );
}
