import type { IconName } from "../components/ui/icon";

/**
 * 设置页左侧导航数据（卡片级，与 SettingsTab 的渲染顺序一一对应）。
 *
 * 为何单独成模块：纯数据放 SettingsTab 会把它推过 300 行上限，且导航项与
 * 卡片 id 的对应关系值得单独维护——改卡片标题时这里要跟着改。
 *
 * `id` 是卡片根元素的 DOM id（Card 透传 `id` prop）。BackupAudit/Notify/
 * Advanced 三张卡原本没有卡级 id，本次补上（`set-backupaudit` / `set-notify` /
 * `set-advanced`），其余沿用既有 id（命令面板锚点早已依赖它们，勿改）。
 */
export interface SettingsSection {
  /** 卡片根元素 id，同时是导航点击的滚动目标。 */
  id: string;
  /** 与卡片 CardTitle 文字保持一致（「关于」卡实际标题是"关于 CC Bridge"，导航取短形式）。 */
  label: string;
  /** 与卡片 CardTitle 的 icon 一致。 */
  icon: IconName;
  /** 仅 Windows 渲染的卡（防火墙），非 Windows 平台导航项同步隐藏。 */
  windowsOnly?: boolean;
  /**
   * 视觉分簇编号。相邻两项 group 不同时，左栏在两者之间画一条 1px 细线。
   *
   * 这是**纯视觉**分簇，不是逻辑归组：不加分组标题、不折叠、不改变项顺序，
   * 也不影响卡片渲染顺序（卡片顺序在 SettingsTab，与本表无关）。目的是让
   * 12 项平铺的长列表有呼吸感，扫起来能分簇。
   *
   * 分簇依据是「概念亲疏」，与卡片既有排序理由（风险 + 改动频率）一致：
   *   0 关于        —— 独立（置顶卡，版本/更新）
   *   1 连通性      —— 网络 / 防火墙 / 安全 / 外挂 MCP 桥
   *                    都回答「远程能不能连进来、连进来能干什么」
   *   2 记录        —— 备份与审计 / 通知（都是"发生过什么"的回看）
   *   3 进阶        —— 高级 / 终端（低频但会回头改）
   *   4 收尾        —— 应用 / 安装与快捷方式 / 配置（装完很少再动）
   */
  group: number;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "set-about", label: "关于", icon: "info", group: 0 },
  { id: "set-network", label: "网络", icon: "server", group: 1 },
  { id: "set-firewall", label: "防火墙", icon: "shield", windowsOnly: true, group: 1 },
  { id: "set-security", label: "安全", icon: "shield", group: 1 },
  { id: "set-mcpbridge", label: "外挂 MCP 桥", icon: "plug", group: 1 },
  { id: "set-backupaudit", label: "备份与审计", icon: "history", group: 2 },
  { id: "set-notify", label: "通知", icon: "activity", group: 2 },
  { id: "set-advanced", label: "高级", icon: "sliders", group: 3 },
  { id: "set-terminal", label: "终端", icon: "terminal", group: 3 },
  { id: "set-app", label: "应用", icon: "monitor", group: 4 },
  { id: "set-install", label: "安装与快捷方式", icon: "package", group: 4 },
  { id: "set-config", label: "配置", icon: "download", group: 4 },
];

/**
 * 按 group 把导航项切成簇（相邻且 group 相同的项归为一簇）。
 *
 * 为何单独成函数而不写在 SettingsNav 里：切簇必须基于**过滤后**的列表算——
 * 「防火墙非 Windows 不渲染」这类过滤发生在渲染之前。抽出来才能单测覆盖
 * 「过滤器把中间某一项拿掉」的情形，否则簇数/细线位置错了也没人发现。
 */
export function groupSettingsSections(sections: SettingsSection[]): SettingsSection[][] {
  const groups: SettingsSection[][] = [];
  for (const s of sections) {
    const last = groups[groups.length - 1];
    if (!last || last[0].group !== s.group) groups.push([s]);
    else last.push(s);
  }
  return groups;
}
