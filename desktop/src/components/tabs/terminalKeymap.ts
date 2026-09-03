import type { Terminal } from "@xterm/xterm";

/** 快捷键要触发的动作。用 ref 承接，因为钩子只注册一次、直接闭包会拿到陈旧引用。 */
export interface TerminalKeyActions {
  paste: () => void;
  copy: () => void;
  openSearch: () => void;
}

/**
 * 给终端装上快捷键拦截。
 *
 * 🔴 复制/粘贴必须赶在 xterm 前面截获。xterm 把 ctrl+字母一律映射成控制字符
 * （`String.fromCharCode(keyCode - 64)`），**这条分支对 shift 没有任何排除**，所以：
 *   Ctrl+V / Ctrl+Shift+V → \x16（SYN），且 preventDefault → 浏览器不产生 paste 事件
 *   Ctrl+Shift+C          → \x03（SIGINT，会中断正在跑的命令）
 *   Ctrl+Shift+A          → \x01
 * `attachCustomKeyEventHandler` 是官方钩子：`_keyDown` 第一件事就是查它，返回 false 直接短路
 * （不发数据、不 preventDefault、不阻止冒泡）。
 *
 * 为什么只抢带 shift 的组合：不带 shift 的 Ctrl+C / Ctrl+A 在终端里分别是 SIGINT 和
 * 「跳行首 / tmux 前缀键」，都是刚需，抢不得；带 shift 的那几个目前只会发出完全相同的
 * 控制字符（shift 被忽略），拿过来不丢任何能力，而且是 GNOME Terminal 等的通行惯例。
 *
 * 代价：远端不再收到 Ctrl+V（readline 的 quoted-insert 失效）——已与使用者确认接受。
 */
export function attachTerminalKeymap(
  term: Terminal,
  actionsRef: { current: TerminalKeyActions },
): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const ctrl = e.ctrlKey || e.metaKey;
    // e.key 在 Ctrl+Shift+V 下是 "V"，故一条判定同时覆盖 Ctrl+V 与 Ctrl+Shift+V。
    if (ctrl && (e.key === "v" || e.key === "V")) {
      actionsRef.current.paste();
      return false;
    }
    if (ctrl && e.shiftKey && (e.key === "c" || e.key === "C")) {
      actionsRef.current.copy();
      return false;
    }
    if (ctrl && e.shiftKey && (e.key === "a" || e.key === "A")) {
      term.selectAll();
      return false;
    }
    // 搜索同理用 Ctrl+Shift+F：Ctrl+F 在 readline 里是光标右移、vim 里是翻页，抢不得。
    if (ctrl && e.shiftKey && (e.key === "f" || e.key === "F")) {
      actionsRef.current.openSearch();
      return false;
    }
    // 🔴 侧栏折叠是 Ctrl+Shift+B，**不是 Ctrl+B**。
    // Ctrl+B 是 tmux 的默认前缀键，也是 readline 的 backward-char（光标左移），
    // 与上面不抢 Ctrl+F 是同一个理由——它们互为镜像。抢了之后更难受的是：
    // preventDefault 不阻止冒泡，于是 xterm 先把 \x02 发给了远端，事件再冒到 window
    // 把侧栏也切了——**两件事同时发生**。现在 Ctrl+B 原样发往远端，
    // 只拦 Ctrl+Shift+B（真正的切换由 TerminalTab 的 window 级监听完成）。
    if (ctrl && e.shiftKey && (e.key === "b" || e.key === "B")) return false;
    // F11 切全屏：同上，这里只负责不发往远端。
    if (e.key === "F11") return false;
    return true;
  });
}
