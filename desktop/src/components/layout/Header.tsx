import { useState, useEffect } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse } from "../../lib/types";
import { getStoredTheme, toggleTheme } from "../../lib/theme";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { APP_INFO } from "../../lib/about";
import { UpdateBadge } from "./UpdateBadge";
import { TitleBarControls } from "./TitleBarControls";

export function Header({
  status,
  onChanged,
  onNavigate,
}: {
  status?: StatusResponse;
  onChanged?: () => void;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const [dark, setDark] = useState(() => getStoredTheme() === "dark");
  const [busy, setBusy] = useState(false);

  // 主题由 lib/theme 统一管理（命令面板也复用），这里只同步图标状态
  useEffect(() => {
    const onTheme = (e: Event) =>
      setDark((e as CustomEvent<"dark" | "light">).detail === "dark");
    window.addEventListener("themechange", onTheme);
    return () => window.removeEventListener("themechange", onTheme);
  }, []);

  const running = status?.running ?? true;
  const startupError = status?.startupError ?? null;

  // 安全状态小徽章：任意页可见，点击跳转到对应设置页
  const securityBadges: {
    key: string;
    show: boolean;
    label: string;
    icon: IconName;
    danger: boolean;
    tab: string;
    anchor?: string;
    title: string;
  }[] = [
    { key: "whitelist", show: !!status && !status.whitelistEnabled, label: "白名单关闭", icon: "alertTriangle", danger: true, tab: "settings", anchor: "whitelist", title: "白名单已关闭，点击前往设置页关闭" },
    { key: "ip", show: !!status?.ipChanged, label: "IP 已变化", icon: "alertTriangle", danger: true, tab: "connect", title: "连接地址已变化，点击前往连接页查看" },
    { key: "readonly", show: !!status?.readonlyMode, label: "只读", icon: "lock", danger: false, tab: "settings", anchor: "readonly", title: "只读模式已开启，点击前往设置页查看" },
    { key: "shell", show: !!status?.shellEnabled, label: "命令执行已开启", icon: "terminal", danger: true, tab: "settings", anchor: "shell", title: "命令执行已开启，点击前往设置页关闭" },
  ];

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
    <header data-tauri-drag-region className="app-header flex shrink-0 items-center justify-between border-b px-5 py-3.5">
      <div data-tauri-drag-region className="flex items-center gap-2.5">
        <img src="/icon.png" alt={APP_INFO.name} width={40} height={40} className="shrink-0 rounded-lg" draggable={false} />
        <h1 className="text-base font-semibold tracking-tight">CC Bridge</h1>
        <UpdateBadge currentVersion={status?.version} />
        {/* 运行状态胶囊：启动失败=红, 运行=绿+脉冲, 停止=灰 (A3) */}
        {/* A3：端口占用等启动错误优先展示为红态，点击跳设置页 */}
        <span
          className={`status-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold${
            startupError
              ? " border-destructive/30 bg-destructive/10 text-destructive"
              : running
              ? " border-success/30 bg-success/10 text-success"
              : " border-border bg-muted text-muted-foreground"
          }`}
          title={startupError ?? undefined}
          {...(startupError && onNavigate ? { onClick: () => onNavigate("settings"), style: { cursor: "pointer" } } : {})}
        >
          <span className={`h-1.5 w-1.5 rounded-full bg-current ${running && !startupError ? "p-dot" : ""}`} />
          {!status ? "连接中" : startupError ? "启动失败" : running ? "运行中" : "已停止"}
        </span>

        {/* 安全状态小徽章：任意页可见，点击跳转到对应设置页（白名单/只读/命令执行→安全页，IP 变化→连接页） */}
        {securityBadges.filter((b) => b.show).map((b) => (
          <button
            key={b.key}
            type="button"
            title={b.title}
            onClick={() => onNavigate?.(b.tab, b.anchor)}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
              b.danger
                ? "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20"
                : "border-warning/30 bg-warning/10 text-warning hover:bg-warning/20"
            }`}
          >
            <Icon name={b.icon} size={11} />
            {b.label}
          </button>
        ))}
      </div>

      <div data-tauri-drag-region="false" className="flex items-center gap-2">
        {/* 启停按钮 */}
        {status && (
          <Button
            variant={running ? "outline" : "default"}
            size="sm"
            isLoading={busy}
            loadingText={running ? "停止中…" : "启动中…"}
            onClick={toggleServer}
            className="gap-1.5"
          >
            {!busy && <Icon name={running ? "pause" : "play"} size={14} />}
            {!busy && (running ? "停止服务" : "启动服务")}
          </Button>
        )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => toggleTheme()}
            aria-label={dark ? "切换浅色" : "切换深色"}
          >
          <Icon name={dark ? "sun" : "moon"} size={18} />
        </Button>

        {/* 窗口控件：最小化、最大化、关闭 — 最右侧 */}
        <TitleBarControls />
      </div>
    </header>
  );
}
