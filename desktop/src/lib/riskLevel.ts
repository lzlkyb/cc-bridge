import type { IconName } from "../components/ui/icon";

/**
 * 风险等级判定（安全页 / 设置页唯一源）。
 *
 * WHY 单独成模块：三个核心安全开关（白名单 / 只读 / 命令执行）曾有两份判定——
 * 设置页 RiskSummary 是两态且不看只读压制，安全页 SecurityOverview 内部另有一份
 * 三态。readonly+shell 同开时两页结论相反（设置页红「命令执行已开启」、安全页绿
 * 「较安全」），同一状态两个结论是比误报更贵的事故。判定收口到这一个纯函数，
 * 两处展示都消费它（ui/RiskBand.tsx），带单测锁死行为。
 *
 * 判定要点（与原 SecurityOverview 内实现逐行一致）：
 * - 只读模式会强制禁用命令执行（后端拦截 run_command），因此「有效」命令执行状态是
 *   shellEnabled && !readonlyMode；否则配置 flag 开着、实际被只读拦住，也会误报高风险。
 * - 三档：高风险（有效 shell 开 或 白名单关）/ 有风险（全开但可写）/ 较安全（只读压制下全开）。
 */

/** 判定所需的三个开关字段（StaticStatus 的结构子集，直接传 status 即可）。 */
export interface SecurityFlags {
  whitelistEnabled: boolean;
  shellEnabled: boolean;
  readonlyMode: boolean;
}

export type RiskLevel = "safe" | "warn" | "high";

export interface RiskVerdict {
  level: RiskLevel;
  /** 等级文案（「较安全」/「有风险」/「高风险」）。 */
  label: string;
  desc: string;
  /** 徽章 pill 的 Tailwind 类（三档配色）。 */
  pill: string;
  /** 等级图标（check / alertTriangle）。 */
  icon: IconName;
}

const PILL: Record<RiskLevel, string> = {
  // 文字用 -ink：与 ui/badge、ui/notice 同一口径（基础语义色浅色淡底不达 AA）
  safe: "border-success/30 bg-success/10 text-success-ink",
  warn: "border-warning/30 bg-warning/10 text-warning-ink",
  high: "border-destructive/30 bg-destructive/10 text-destructive-ink",
};

export function riskLevel(status: SecurityFlags): RiskVerdict {
  const shellOn = status.shellEnabled && !status.readonlyMode;
  const whitelistOff = !status.whitelistEnabled;

  if (shellOn || whitelistOff) {
    let desc: string;
    if (shellOn && whitelistOff) desc = "命令执行已开启且白名单已关闭，风险极高。";
    else if (shellOn) desc = "命令执行已开启，存在远程代码执行（RCE）风险。";
    else desc = "路径白名单已关闭，远程可读写本机全部文件。";
    return { level: "high", label: "高风险", desc, pill: PILL.high, icon: "alertTriangle" };
  }
  if (!status.readonlyMode) {
    return {
      level: "warn",
      label: "有风险",
      desc: "白名单校验已开启，但处于可写状态，远程可修改白名单内文件。",
      pill: PILL.warn,
      icon: "alertTriangle",
    };
  }
  return {
    level: "safe",
    label: "较安全",
    desc: "核心高危功能已关闭，远程仅能在白名单内做只读访问。",
    pill: PILL.safe,
    icon: "check",
  };
}
