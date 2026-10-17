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
   * 视觉分簇编号，语义见 {@link SETTINGS_CLUSTERS}。
   *
   * 这是**纯视觉**分簇，不是逻辑归组：不折叠、不改变导航/卡片顺序之外的任何行为。
   * 2026-10-17 起簇按「概念族」划分（安全与接入 / 数据与记录 / 体验…），
   * 与卡片语义同轴，见 SETTINGS_CLUSTERS 注释。
   */
  group: number;
}

/**
 * 簇元数据：group 编号 → 簇标题。
 *
 * 2026-10-17（设置页信息架构与文案分层方案）：簇名从「任务导向」改回与卡片一致的
 * 「概念族」——旧的「每天会用 / 记录与回溯」装着概念卡（安全 / 通知），扫视对不上号：
 * - 「安全与接入」：安全 + 外挂 MCP 桥（桥本质是给 AI 开权限，属安全域）；
 * - 「数据与记录」：备份与审计 + Token 用量（通知移去「体验」）；
 * - 「体验」：通知 + 终端 + 应用。
 * `title` 缺省的簇（关于）不渲染标题行——「关于」置顶是既有用户决定，它独自一簇。
 */
export const SETTINGS_CLUSTERS: { group: number; title?: string }[] = [
  { group: 0 }, // 关于——独立置顶，无标题
  { group: 1, title: "开始使用" }, // 安装 / 网络 / 防火墙
  { group: 2, title: "安全与接入" }, // 安全 / 外挂 MCP 桥
  { group: 3, title: "数据与记录" }, // 备份与审计 / Token 用量
  { group: 4, title: "体验" }, // 通知 / 终端 / 应用
  { group: 5, title: "高级" }, // 高级 / 配置
];

/**
 * 顺序即导航顺序，也是 SettingsTab 右列卡片顺序（两边同源，改这里即改两边）。
 *
 * 与旧版（2026-09 风险排序）的差异：「安装与快捷方式」从第 12 项**上移**到
 * 第 2 项——首次接入的第一站（装完找安装目录 / 重看引导），却埋在收尾簇里；
 * 「通知」图标 activity → bell（原与 Token 用量撞图标）。
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "set-about", label: "关于", icon: "info", group: 0 },
  { id: "set-install", label: "安装与快捷方式", icon: "package", group: 1 },
  { id: "set-network", label: "网络", icon: "server", group: 1 },
  { id: "set-firewall", label: "防火墙", icon: "shield", windowsOnly: true, group: 1 },
  { id: "set-security", label: "安全", icon: "shield", group: 2 },
  { id: "set-mcpbridge", label: "外挂 MCP 桥", icon: "plug", group: 2 },
  { id: "set-backupaudit", label: "备份与审计", icon: "history", group: 3 },
  { id: "set-tokenusage", label: "Token 用量", icon: "activity", group: 3 },
  { id: "set-notify", label: "通知", icon: "bell", group: 4 },
  { id: "set-terminal", label: "终端", icon: "terminal", group: 4 },
  { id: "set-app", label: "应用", icon: "monitor", group: 4 },
  { id: "set-advanced", label: "高级", icon: "sliders", group: 5 },
  { id: "set-config", label: "配置", icon: "download", group: 5 },
];

/** 一个渲染簇：标题（可缺省）+ 该簇的导航项。 */
export interface SettingsClusterGroup {
  title?: string;
  items: SettingsSection[];
}

/**
 * 按 group 把导航项切成簇（相邻且 group 相同的项归为一簇），并挂上簇标题。
 *
 * 为何单独成函数而不写在 SettingsNav 里：切簇必须基于**过滤后**的列表算——
 * 「防火墙非 Windows 不渲染」这类过滤发生在渲染之前。抽出来才能单测覆盖
 * 「过滤器把中间某一项拿掉」的情形，否则簇数/细线位置错了也没人发现。
 */
export function groupSettingsSections(sections: SettingsSection[]): SettingsClusterGroup[] {
  const groups: SettingsClusterGroup[] = [];
  for (const s of sections) {
    const last = groups[groups.length - 1];
    if (!last || last.items[0].group !== s.group) {
      groups.push({
        title: SETTINGS_CLUSTERS.find((c) => c.group === s.group)?.title,
        items: [s],
      });
    } else {
      last.items.push(s);
    }
  }
  return groups;
}
