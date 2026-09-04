import type { IconName } from "../components/ui/icon";

/**
 * 设置项搜索索引（设计稿：design/设置项搜索-方案D-设计稿.html）。
 *
 * 为何单独成模块：这是**纯数据**（不含闭包/回调），放在 CommandPalette 里会把那个
 * 文件推过 300 行上限，而且数据与交互混在一起后没法单测。
 *
 * 只做**跳转**，不代操：开关带二次确认（白名单 / 命令执行）、带上下文描述、带
 * 「只读模式下命令执行被强制禁止」这类联动。在搜索框里“打字回车就改了安全设置”
 * 是真风险——命令面板里「清空审计日志」那项当初就因为这个补了 ConfirmDialog。
 * 所以这里每一条都只有 tab + anchor，没有 run。
 */
export interface SettingSearchItem {
  id: string;
  label: string;
  icon: IconName;
  group: string;
  tab: string;
  /**
   * 定位锚点。开关类传裸名（`shell` → 命中 `toggle-shell`），卡级传完整 id
   * （`set-network`）——SettingsTab 的定位 effect 先试 `toggle-<a>` 再回退字面 id。
   * 安全页尚未重构，那两条不带 anchor，仅跳页。
   */
  anchor?: string;
  /** 额外搜索词（不展示）。用户想到的词往往不是标题：rce / GBK / 端口 / 内存。 */
  keywords?: string;
}

export const SETTING_SEARCH_ITEMS: SettingSearchItem[] = [
  { id: "set-whitelist", label: "路径白名单校验", icon: "shield", group: "设置 · 安全", tab: "settings", anchor: "whitelist", keywords: "whitelist 目录限制 路径校验" },
  { id: "set-readonly", label: "只读模式", icon: "lock", group: "设置 · 安全", tab: "settings", anchor: "readonly", keywords: "readonly 禁止写入 不允许删除" },
  { id: "set-shell", label: "命令执行", icon: "terminal", group: "设置 · 安全", tab: "settings", anchor: "shell", keywords: "shell rce run_command 执行命令" },
  { id: "set-shelltype", label: "命令执行壳层", icon: "terminal", group: "设置 · 安全", tab: "settings", anchor: "shell", keywords: "shell cmd bash sh git bash 壳层" },

  { id: "set-backup", label: "写操作自动备份", icon: "history", group: "设置 · 备份与审计", tab: "settings", anchor: "backup", keywords: "backup 备份 快照" },
  { id: "set-audit", label: "审计日志", icon: "file", group: "设置 · 备份与审计", tab: "settings", anchor: "audit", keywords: "audit 日志 记录 留痕" },
  { id: "set-audit-days", label: "审计保留天数", icon: "clock", group: "设置 · 备份与审计", tab: "settings", anchor: "audit", keywords: "retention 保留 天数 过期" },
  { id: "set-audit-clean", label: "清理早于…（审计）", icon: "trash", group: "设置 · 备份与审计", tab: "settings", anchor: "audit", keywords: "清理 删除旧日志 cleanup" },

  { id: "set-notify-cmd", label: "后台命令完成通知", icon: "activity", group: "设置 · 通知", tab: "settings", anchor: "notify-command", keywords: "notify 通知 toast 推送" },
  { id: "set-notify-task", label: "任务完成通知", icon: "activity", group: "设置 · 通知", tab: "settings", anchor: "notify-task", keywords: "notify push_notification 通知 推送" },

  { id: "set-ratelimit", label: "限流保护", icon: "sliders", group: "设置 · 高级", tab: "settings", anchor: "ratelimit", keywords: "rate limit 限流 频率" },
  { id: "set-encoding", label: "读取编码自适应", icon: "file", group: "设置 · 高级", tab: "settings", anchor: "encoding", keywords: "encoding gbk gb18030 utf-8 乱码 编码" },
  { id: "set-session", label: "命令会话持久化", icon: "terminal", group: "设置 · 高级", tab: "settings", anchor: "session-persist", keywords: "session cwd venv env 环境变量 工作目录" },
  { id: "set-release-webview", label: "关窗时释放界面内存", icon: "monitor", group: "设置 · 高级", tab: "settings", anchor: "release-webview", keywords: "内存 memory webview 占用 关窗" },

  { id: "set-network", label: "监听端口 / MCP 传输协议", icon: "server", group: "设置 · 其它", tab: "settings", anchor: "set-network", keywords: "port 7823 端口 transport http sse 协议" },
  // 仅 Windows 渲染（`SettingsTab` 里有 isWindows 守卫）。非 Windows 上点了会跳到设置页但
  // 找不到锚点——SettingsTab 的定位 effect 对找不到的 id 是静默返回的，不会报错。
  { id: "set-firewall", label: "防火墙规则与一键修复", icon: "shield", group: "设置 · 其它", tab: "settings", anchor: "set-firewall", keywords: "firewall netsh 入站 放行 端口 拦截 远程连不上" },
  { id: "set-app", label: "开机自动启动", icon: "power", group: "设置 · 其它", tab: "settings", anchor: "set-app", keywords: "autostart 开机启动 开机自启" },
  { id: "set-install", label: "安装与快捷方式", icon: "package", group: "设置 · 其它", tab: "settings", anchor: "set-install", keywords: "install 快捷方式 桌面 安装目录" },
  { id: "set-config", label: "导入 / 导出 / 重置配置", icon: "download", group: "设置 · 其它", tab: "settings", anchor: "set-config", keywords: "import export reset 备份配置 恢复默认" },
  { id: "set-about", label: "版本信息 / 检查更新", icon: "info", group: "设置 · 其它", tab: "settings", anchor: "set-about", keywords: "version update 更新 版本 更新历史 changelog" },
  { id: "set-terminal", label: "终端风格与状态栏", icon: "sliders", group: "设置 · 其它", tab: "settings", anchor: "set-terminal", keywords: "terminal preset 终端风格 starship 状态栏 注入 探测 远端 shell" },

  // 安全页未重构，暂不加卡级锚点，先只跳页——至少不让用户在设置页白找。
  { id: "set-roots", label: "白名单目录与配置组", icon: "folder", group: "安全页", tab: "security", keywords: "root 根目录 白名单 配置组 项目切换" },
  { id: "set-backup-mgmt", label: "备份份数 / 目录 / 版本历史 / 清理", icon: "history", group: "安全页", tab: "security", keywords: "backup retention 备份目录 版本历史 清理备份 还原" },
];
