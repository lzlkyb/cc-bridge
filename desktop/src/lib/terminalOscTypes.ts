/**
 * 远端状态栏 / 标签徽标共用的类型。
 *
 * 从 `hooks/useTerminalOsc.ts` 搬出来（2026-11-03）：那个 hook 已经贴着 300 行体量线，
 * 而类型定义和 hook 实现混在一个文件里，谁都动不了。这里只是类型，没有运行时依赖。
 */

/** 状态栏可见的远端信息。未拿到的字段保持 null，由状态栏决定要不要显示。 */
export interface TerminalStatus {
  /** 远端当前目录（OSC 7）。null = 还没收到。 */
  cwd: string | null;
  /** git 分支（钩子探测）。null = 非 git 仓库或还没收到。 */
  branch: string | null;
  /** 上一条命令退出码（OSC 133;D）。null = 还没收到。 */
  exitCode: number | null;
  /** 上一条命令耗时毫秒（OSC 133;A→D 配对），null = 还没完成过一条命令。 */
  lastCmdMs: number | null;
  /**
   * 命令结束的递增序号（每收到一次 OSC 133;D +1）。
   *
   * 用来做「有新命令结束」的边沿检测。不能拿 `exitCode` / `lastCmdMs` 比：连跑两条
   * 耗时相同的短命令（都是 3ms）就分辨不出是新的一条；也不能拿整个 `status` 对象比引用——
   * cwd（OSC 7）和 branch 的变化同样会换掉它。重连时归零。
   */
  cmdSeq: number;
}

/**
 * 钩子状态机：`pending` 探测中 / `ready` 钩子已生效 / `off` 设置里关了注入 /
 * `unsupported` 远端不是 bash/zsh 或注入出错（**自动降级，不重试**）/
 * `skipped` 用户在准备期就开始打字，主动放弃注入（不是缺陷，提示语必须区别对待）。
 */
export type OscState = "pending" | "ready" | "off" | "unsupported" | "skipped" | "termNotReady";
