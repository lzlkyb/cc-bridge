import type { Terminal } from "@xterm/xterm";
import {
  isOsc133A,
  isSupportedShell,
  parseOsc7,
  parseOsc133,
  parseOsc1337,
} from "./terminalStatusbar";
import { navCmdEnd, navCmdStart, navCmdText } from "./terminalCommandNav";

/**
 * OSC 解析 ↔ 会话状态之间的接缝。
 *
 * WHY 单独拆一层：`useTerminalOsc` 既管**协议解析**（哪个 OSC 代表什么、要不要消费掉）
 * 又管**会话编排**（注入舞步、ECHO 恢复、状态机）。前者是「字节进、语义出」的纯逻辑，
 * 后者是有时序和副作用的状态机，混在一个文件里两边都难测、也把 hook 撑过了体量门禁。
 *
 * 这里只做两件事：把 xterm 的 OSC 回调翻成具名事件；把命令导航（133;A/D 配对算耗时）
 * 这类纯 DOM/buffer 操作就地做完。状态与舞步全部交回调用方。
 */
export interface OscBridgeHooks {
  /** 注入开关的实时值（关闭时所有 OSC 一律吞掉，不更新状态）。 */
  enabled: () => boolean;
  /** OSC 7：远端当前目录。已经解析好，null/空串不会走到这里。 */
  onCwd: (cwd: string) => void;
  /** OSC 133;A：一条命令开始（钩子生效的强信号）。 */
  onCommandStart: () => void;
  /** OSC 133;D：命令结束，`durMs` 为 A→D 配对出的耗时（拿不到为 null）。 */
  onCommandEnd: (code: number, durMs: number | null) => void;
  /** OSC 1337;Git=：当前目录的 git 分支。 */
  onBranch: (branch: string) => void;
  /** OSC 1337;Shell=：探针回执，且 `$0` 是 bash/zsh——可以注入钩子了。 */
  onProbeOk: (shell: string) => void;
  /** OSC 1337;Shell=：回执回来了但 shell 不是 bash/zsh（fish/ksh 也会回执）。 */
  onProbeUnsupported: (shell: string) => void;
  /** 用户敲了任意键（含粘贴、粘贴图片路径）。`data` 是本次到达的字节。 */
  onUserInput: (data: string) => void;
}

/**
 * 在终端实例上挂 OSC 7 / 133 / 1337 与输入监听，返回一次性注销函数。
 *
 * 🔴 与 sessionId 无关地挂在**终端实例**上：OSC 数据来自这个终端的输出流，重连不该重挂。
 */
export function attachOscHandlers(term: Terminal, hooks: OscBridgeHooks): () => void {
  const d7 = term.parser.registerOscHandler(7, (data) => {
    if (!hooks.enabled()) return true;
    const cwd = parseOsc7(data);
    if (cwd) hooks.onCwd(cwd);
    return true; // 已消费：不要让 xterm 再处理
  });

  // 只把「命令结束」当钩子生效的信号（D 带退出码，也是要显示的那段）。
  // 顺路喂命令导航：A 钉 marker（跳转锚点），D 配对算耗时给状态栏显示。
  const d133 = term.parser.registerOscHandler(133, (data) => {
    if (!hooks.enabled()) return true;
    if (isOsc133A(data)) {
      navCmdStart(term);
      hooks.onCommandStart();
      return true;
    }
    const code = parseOsc133(data);
    if (code === null) return false;
    hooks.onCommandEnd(code, navCmdEnd(term, code));
    return true;
  });

  const d1337 = term.parser.registerOscHandler(1337, (data) => {
    if (!hooks.enabled()) return true;
    const { shell, git, cmd } = parseOsc1337(data);
    if (shell) {
      // 🔴 门禁：回执 ≠ 支持——fish/ksh 也能执行探针并回执，钩子（bash 语法）盲发
      // 会在对方屏幕喷语法错误。必须由调用方立即恢复 ECHO，不能等探针超时
      // （那个窗口里 ECHO 是关的，用户敲键会隐形）。
      if (isSupportedShell(shell)) hooks.onProbeOk(shell);
      else hooks.onProbeUnsupported(shell);
    }
    // 分支按目录缓存：钩子只在 cwd 变化时才发，直接替换（旧分支属旧目录）。
    if (git) hooks.onBranch(git);
    // 命令文本与 133;D 同轮到达（钩子一次 printf 连发），回填到 D 刚填退出码的那一块。
    if (cmd) navCmdText(term, cmd);
    return true;
  });

  const onData = term.onData((data) => hooks.onUserInput(data));

  return () => {
    d7.dispose();
    d133.dispose();
    d1337.dispose();
    onData.dispose();
  };
}
