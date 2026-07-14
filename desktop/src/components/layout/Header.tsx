import { useState, useEffect, useMemo, memo } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse } from "../../lib/types";
import { getStoredTheme, toggleTheme } from "../../lib/theme";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { APP_INFO } from "../../lib/about";
import { UpdateBadge } from "./UpdateBadge";
import { TitleBarControls } from "./TitleBarControls";

function HeaderImpl({
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

  // S5: 未知态(轮询间隙/首帧)一律视为未运行，避免 `?? true` 制造"总在运行"的错觉
  const running = status?.running ?? false;
  const startupError = status?.startupError ?? null;

  // E-P1-10: useMemo 避免每帧重建 badge 数组
  const securityBadges: {
    key: string;
    show: boolean;
    label: string;
    icon: IconName;
    danger: boolean;
    tab: string;
    anchor?: string;
    title: string;
  }[] = useMemo(() => [
    { key: "whitelist", show: !!status && !status.whitelistEnabled, label: "白名单关闭", icon: "alertTriangle" as IconName, danger: true, tab: "settings", anchor: "whitelist", title: "白名单已关闭，点击前往设置页关闭" },
    { key: "ip", show: !!status?.ipChanged, label: "IP 已变化", icon: "alertTriangle" as IconName, danger: true, tab: "connect", title: "连接地址已变化，点击前往连接页查看" },
    { key: "link", show: !!status?.running && status?.remoteReachable === false && !status?.ipChanged, label: "远程不可达", icon: "alertTriangle" as IconName, danger: true, tab: "connect", title: "远程连接不可达，点击前往连接页查看" },
    { key: "readonly", show: !!status?.readonlyMode, label: "只读", icon: "lock" as IconName, danger: false, tab: "settings", anchor: "readonly", title: "只读模式已开启，点击前往设置页查看" },
    { key: "shell", show: !!status?.shellEnabled, label: "命令执行已开启", icon: "terminal" as IconName, danger: true, tab: "settings", anchor: "shell", title: "命令执行已开启，点击前往设置页关闭" },
  ], [status]);

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

  // S2: 链路状态机。linkDown = 服务在跑，但地址变了或探针不通（远程连不回本机）。
  // 这正是此前"服务显示运行却连不上"的真相——用醒目的红态暴露出来，绝不淹没。
  const linkDown = !!status && !!running && (status.ipChanged || status.remoteReachable === false);

  // E-P2-9: useMemo 避免每渲染拼接 className 三元链
  const pillClassName = useMemo(
    () =>
      `status-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold${
        startupError
          ? " border-destructive/30 bg-destructive/10 text-destructive"
          : !running
          ? " border-border bg-muted text-muted-foreground"
          : linkDown
          ? " border-destructive/30 bg-destructive/10 text-destructive"
          : " border-success/30 bg-success/10 text-success"
      }`,
    [startupError, running, linkDown],
  );
  const pillText = !status
    ? "连接中"
    : startupError
    ? "启动失败"
    : !running
    ? "已停止"
    : linkDown
    ? "远程连接中断"
    : "已连接";

  return (
    <header data-tauri-drag-region className="app-header flex shrink-0 items-center justify-between border-b px-5 py-3.5">
      <div data-tauri-drag-region className="flex items-center gap-2.5">
        <img src="/icon.png" alt={APP_INFO.name} width={40} height={40} className="shrink-0 rounded-lg" draggable={false} />
        <h1 className="text-base font-semibold tracking-tight">CC Bridge</h1>
        <UpdateBadge currentVersion={status?.version} />

        {/* 运行状态胶囊：启动失败=红, 运行=绿+脉冲, 停止=灰 (A3) */}
        <span
          className={pillClassName}
          title={startupError ?? (linkDown ? "网络地址已失效，远程连接中断" : undefined)}
          {...(startupError && onNavigate
            ? { onClick: () => onNavigate("settings"), style: { cursor: "pointer" } }
            : linkDown && onNavigate
            ? { onClick: () => onNavigate("connect"), style: { cursor: "pointer" } }
            : {})}
        >
          <span className={`h-1.5 w-1.5 rounded-full bg-current ${running && !startupError && !linkDown ? "p-dot" : ""}`} />
          {pillText}
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

export const Header = memo(HeaderImpl);
