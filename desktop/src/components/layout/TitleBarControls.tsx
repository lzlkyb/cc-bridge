import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "../ui/icon";

/**
 * 自定义窗口控件：最小化、最大化/还原、关闭（隐藏到托盘）。
 * 无系统标题栏（decorations: false）时替代原生按钮。
 */
export function TitleBarControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();

    // 初始化：查询当前最大化状态
    win.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    }).catch(() => {});

    // 监听窗口大小变化，同步最大化状态
    const unlisten = win.onResized(() => {
      win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      }).catch(() => {});
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  const minimize = useCallback(() => {
    getCurrentWindow().minimize().catch(() => {});
  }, []);

  const toggleMaximize = useCallback(() => {
    getCurrentWindow().toggleMaximize().catch(() => {});
  }, []);

  const close = useCallback(() => {
    // 关闭 = 隐藏到托盘（与 CloseRequested → hide() 一致）
    getCurrentWindow().hide().catch(() => {});
  }, []);

  const btnCls = "flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:bg-accent hover:text-accent-foreground active:scale-95";

  return (
    <div className="flex items-center gap-0.5" data-tauri-drag-region="false">
      {/* 最小化 */}
      <button
        className={btnCls}
        onClick={minimize}
        title="最小化"
        aria-label="最小化"
      >
        <Icon name="minimize" size={16} />
      </button>

      {/* 最大化 / 还原 */}
      <button
        className={btnCls}
        onClick={toggleMaximize}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
      >
        <Icon name={maximized ? "restore" : "maximize"} size={14} />
      </button>

      {/* 关闭（隐藏到托盘） */}
      <button
        className={`${btnCls} hover:bg-destructive hover:text-destructive-foreground`}
        onClick={close}
        title="关闭窗口（后台运行）"
        aria-label="关闭窗口"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
