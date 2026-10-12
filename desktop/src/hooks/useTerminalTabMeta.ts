import { useEffect, useRef, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { ProgressAddon, type IProgressState } from "@xterm/addon-progress";
import { sanitizeTitle } from "../lib/terminalTabMeta";

export type { IProgressState };

/** 标签 meta 增量：只带本次变化的字段。字段名与 TermTabMeta 对齐，可直接喂 patchMeta。 */
export interface TermTabMetaPatch {
  title?: string | null;
  progress?: IProgressState | null;
  /**
   * BEL 铃事件：附事件时间戳。
   * 🔴 不能用 `bell?: boolean` 之类与 TermTabMeta 不同名的信号字段——patchMeta 是
   * 浅合并 Partial<TermTabMeta>，多余字段（TS 结构兼容、不报错）会被**静默丢弃**，
   * bellAt 永远不会被写上，标签铃点永远不亮。
   */
  bellAt?: number;
}

interface Args {
  termRef: RefObject<Terminal | null>;
  onMeta: (patch: TermTabMetaPatch) => void;
  /** 会话已断开：不再挂事件（重连由父组件换 sessionId 重挂组件承接）。 */
  closed: boolean;
}

/**
 * 终端内部事件 → 标签栏 meta 的上报桥（P0 批次「标签页友好化」）：
 * - **OSC 0/2 标题** → 净化后上报，标签显示 `主机 ▸ 程序名`；
 * - **OSC 9;4 进度**（ConEmu 协议）→ addon-progress 解析后上报，标签画细进度条；
 * - **BEL 铃** → 上报 bell 事件（toast 与否由组件按可见性决定）。
 *
 * WHY 独立成 hook：`useSshTerminalSession` 在体量棘轮基线上（一行不能加），
 * 这三个事件又都只是「监听 → 转发」，不值得塞进任何现有 hook。
 * ProgressAddon 也在这里 load：xterm 允许随时 loadAddon，与其它 addon 无耦合。
 *
 * WHY onMeta 用 ref 承接：调用方传内联箭头函数，进依赖会让本 effect 每次
 * 渲染重跑（反复 loadAddon / 重挂监听）。
 */
export function useTerminalTabMeta({ termRef, onMeta, closed }: Args) {
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  useEffect(() => {
    const term = termRef.current;
    if (!term || closed) return;
    const progressAddon = new ProgressAddon();
    term.loadAddon(progressAddon);

    const offTitle = term.onTitleChange((raw) => {
      onMetaRef.current({ title: sanitizeTitle(raw) });
    });
    const offProgress = progressAddon.onChange((state) => {
      onMetaRef.current({ progress: state });
    });
    const offBell = term.onBell(() => {
      onMetaRef.current({ bellAt: Date.now() });
    });
    return () => {
      offTitle.dispose();
      offProgress.dispose();
      offBell.dispose();
      progressAddon.dispose();
    };
    // 终端实例由 session hook 创建（其 effect 先于本 effect 运行），termRef 必有值。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂一次；closed 翻转时卸载
  }, [closed]);
}
