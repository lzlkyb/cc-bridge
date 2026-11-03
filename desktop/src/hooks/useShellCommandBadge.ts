import { useEffect, useRef } from "react";
import { SHELL_APP, type ProgramStatus } from "../lib/terminalProgramStatus";
import type { TermTabMetaPatch } from "./useTerminalTabMeta";
import type { TerminalStatus } from "./useTerminalOsc";

/**
 * 普通 shell 命令跑完后，在标签上点亮徽标。
 *
 * ## 为什么需要
 * OSC 7501 只覆盖会自报状态的程序（Claude Code）。`cargo build` / `apt install` / `rsync`
 * 这类普通命令在标签上**毫无痕迹**——而退出码和耗时只喂给当前标签的状态栏，
 * 切走就看不见了（那条状态栏注释自己写的是「长命令挂后台时一眼看出它刚结束没有」）。
 * 于是一个挂了一小时的构建失败在标签栏上完全不可见。
 *
 * ## 信号为什么免费
 * `useTerminalOsc` 早就在解析 `OSC 133;D;code`（提示符钩子注入的副产物），
 * 命令结束的退出码与耗时本来就有。这里只是把它接到标签 meta 上——
 * 徽标形态、未读、汇总药丸全部复用现成的 CC 那套，不新增视觉语言。
 *
 * ## 口径缺陷（必须承认）
 * `lastCmdMs` 量的是「133;A → 133;D」，**包含用户敲命令的时间**（`terminalCommandNav.ts`
 * 头注已说明；精确到「命令开始执行」需要 `133;C`，那要改 PS1 / DEBUG trap，项目明确不做）。
 * 所以只能做「耗时超过阈值的命令结束了」这种粗粒度提示，**不能宣称能识别所有命令**。
 * 两道闸把误报压到很低：只有标签**不可见**时才提示（后台标签里用户不可能正在敲命令），
 * 且耗时必须超过 `SLOW_CMD_MS`。
 */
const SLOW_CMD_MS = 5000;

export function useShellCommandBadge({
  status,
  visible,
  agent,
  onMeta,
}: {
  status: TerminalStatus;
  /** 该会话当前是否可见。可见时用户已经盯着它跑完了，再点亮就是噪声。 */
  visible: boolean;
  /** 该会话的 OSC 7501 状态。CC 正在干活 / 等确认时以它为准，不被 shell 覆盖。 */
  agent: ProgramStatus | null;
  onMeta: (patch: TermTabMetaPatch) => void;
}) {
  const seqRef = useRef(status.cmdSeq);
  useEffect(() => {
    // 边沿检测：cwd / branch 变化也会换掉 status 对象，不能比引用。
    if (status.cmdSeq === seqRef.current) return;
    seqRef.current = status.cmdSeq;
    if (visible) return;
    if (status.lastCmdMs == null || status.lastCmdMs < SLOW_CMD_MS) return;
    // CC 正在执行任务或等你确认时，谁在跑是它说了算；done / error / idle 则可以覆盖
    // （用户退出 CC 回到 shell 再跑命令时，那条命令的结束才是最新事实）。
    if (agent && (agent.state === "working" || agent.state === "blocked")) return;

    const exit = status.exitCode ?? 0;
    const secs = Math.max(1, Math.round(status.lastCmdMs / 1000));
    onMeta({
      agent: {
        state: exit === 0 ? "done" : "error",
        kind: null,
        app: SHELL_APP,
        title: null,
        msg:
          exit === 0
            ? `上一条命令完成，用时 ${secs} 秒`
            : `上一条命令失败（退出码 ${exit}），用时 ${secs} 秒`,
        progress: null,
      },
    });
  }, [status, visible, agent, onMeta]);
}
