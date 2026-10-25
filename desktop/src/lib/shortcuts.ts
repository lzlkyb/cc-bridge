/**
 * 快捷键速查层的单一真源（设计稿《命令面板-拼音模糊与最近使用》D 期，`?` 唤起）。
 *
 * 🔴 这里是「登记处」，不是「实现处」：各键位的监听在 App / CcGuiTab /
 *    SshTerminal 里。加键位要两边一起动 —— 只改实现不改这里，速查层就成了谎报。
 */

export type ShortcutRow = { keys: string[]; desc: string };
export type ShortcutGroup = { title: string; rows: ShortcutRow[] };

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "全局",
    rows: [
      { keys: ["Ctrl", "K"], desc: "命令面板（支持拼音首字母，mx → 模型）" },
      { keys: ["Ctrl", "1…5"], desc: "切换工作区页面" },
      { keys: ["Ctrl", ","], desc: "打开设置" },
    ],
  },
  {
    title: "对话页",
    rows: [
      { keys: ["Ctrl", "N"], desc: "新开一条会话" },
      { keys: ["Ctrl", "F"], desc: "搜索当前会话" },
    ],
  },
  {
    title: "终端页",
    rows: [
      { keys: ["Ctrl", "⇧", "F"], desc: "搜索终端内容" },
      { keys: ["Ctrl", "⇧", "↑", "↓"], desc: "跳上一条 / 下一条命令" },
      { keys: ["Ctrl", "⇧", "V"], desc: "粘贴剪贴板图片并上传远端" },
    ],
  },
];

/** 键帽文案的平台映射（mac 显示 ⌘/⌥）。platform 取自后端 get_status。 */
export function keycapLabel(key: string, platform?: string): string {
  if (platform !== "macos") return key;
  if (key === "Ctrl") return "⌘";
  if (key === "Alt") return "⌥";
  return key;
}
