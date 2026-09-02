import { useEffect, useState, type RefObject } from "react";

/** 侧栏折叠态的 localStorage 键。 */
const SIDEBAR_KEY = "cc-bridge.ssh-sidebar-collapsed";

/**
 * 终端页的两个纯视图开关（侧栏折叠 / 软件内全屏）及其快捷键。
 *
 * @param rootRef      终端页根元素，用于判断本页是否在前台（见下方 F11 的门槛）。
 * @param activeId     当前活动会话 id，null = 没有已连接的终端。
 */
export function useTerminalViewState(
  rootRef: RefObject<HTMLElement | null>,
  activeId: string | null,
) {
  // 侧栏折叠态（图标 rail）：localStorage 记忆，刷新/重开保持，零后端改动。
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      /* 隐私模式等无 localStorage 时忽略 */
    }
  }, [collapsed]);

  // 软件内全屏：右侧面板 fixed 铺满窗口，盖住 Header / Tab 栏 / 侧栏。
  const [fullscreen, setFullscreen] = useState(false);

  // 快捷键 Ctrl/Cmd+B 切换折叠（VS Code 习惯）。终端聚焦时 keydown 仍冒泡到 window，
  // 故全局监听即可；preventDefault 阻止终端把该组合键当输入发往远端。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // F11 切全屏。两道门槛：
  // ① 终端页不在前台时不抢 F11——App 用 display:none 隐藏本页（为保活 SSH 会话不卸载），
  //    此时 offsetParent 为 null；否则在连接页按 F11 会默默置上全屏态。
  // ② 没有活动会话时不进全屏：全屏态下侧栏被盖住，而唯一的退出按钮在终端工具栏上，
  //    空面板全屏会把用户困住。
  //
  // 不用 Esc 作退出键：Esc 在终端里是刚需（vim / Claude Code 都靠它），抢过来代价太大。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      if (!rootRef.current?.offsetParent) return;
      if (!activeId) return;
      e.preventDefault();
      setFullscreen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootRef, activeId]);

  // 最后一个会话断开（或被远端踢下线）时自动退出全屏，同样是为了不把用户困在空面板里。
  useEffect(() => {
    if (!activeId) setFullscreen(false);
  }, [activeId]);

  return { collapsed, setCollapsed, fullscreen, setFullscreen };
}
