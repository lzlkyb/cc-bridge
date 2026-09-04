import { useEffect } from "react";
import type { StaticStatus } from "../../lib/types";
import { isWindows } from "../../lib/platform";
import { FirewallGroup } from "./firewall/FirewallGroup";
import { AboutGroup } from "./AboutGroup";
import { RiskSummary } from "./settings/RiskSummary";
import { NetworkGroup } from "./settings/NetworkGroup";
import { SecurityGroup } from "./settings/SecurityGroup";
import { McpBridgeGroup } from "./settings/mcpbridge/McpBridgeGroup";
import { BackupAuditGroup } from "./settings/BackupAuditGroup";
import { NotifyGroup } from "./settings/NotifyGroup";
import { AdvancedGroup } from "./settings/AdvancedGroup";
import { TerminalGroup } from "./settings/TerminalGroup";
import { AppGroup } from "./settings/AppGroup";
import { InstallGroup } from "./settings/InstallGroup";
import { ConfigGroup } from "./settings/ConfigGroup";

export function SettingsTab({
  status,
  onSaved,
  highlightAnchor,
  unreadCount,
  onReopenOnboarding,
  onMarkSeen,
  changelogOpenToken,
}: {
  status?: StaticStatus;
  onSaved: () => void;
  highlightAnchor?: { anchor: string; nonce: number } | null;
  unreadCount?: number;
  /** H3：重新查看首次使用引导。 */
  onReopenOnboarding?: () => void;
  /** 看完更新历史后标记已读（红点消失）。 */
  onMarkSeen?: () => void;
  /** 自增信号：变化时自动展开关于卡片并滚动到更新历史。 */
  changelogOpenToken?: number;
}) {
  // 由 Header 安全徽章 / 命令面板触发的定位 + 高亮。
  //
  // 提到页面级：拆卡后 `toggle-*` 分散在安全 / 高级 / 通知三张卡里，放在某一张卡
  // 里就只能定位到自己那几个。这里用 getElementById 全局查，与卡片归属无关。
  // 非激活 Tab 在 Tabs 中为 return null（完全卸载），切到设置页时本组件才挂载，
  // 子组件先于父 effect 挂载完成，所以挂载即可定位，无需额外延时。
  useEffect(() => {
    if (!highlightAnchor?.anchor) return;
    // 先试 `toggle-<a>`，再回退到字面 id。
    //
    // 保留 `toggle-` 尝试是为了不弄坏 Header 安全徽章——它传的是裸名
    // （`whitelist` / `readonly` / `shell`）；回退到字面 id 是为了让命令面板能
    // 跳到卡级锚点（`set-network` 这类），否则非开关类设置只能跳到页顶。
    const el =
      document.getElementById(`toggle-${highlightAnchor.anchor}`) ??
      document.getElementById(highlightAnchor.anchor);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("anchor-highlight");
    const t = setTimeout(() => el.classList.remove("anchor-highlight"), 2000);
    return () => clearTimeout(t);
  }, [highlightAnchor]);

  return (
    <div className="space-y-4 settings-tab">
      {/* 风险总览从原「功能开关」卡内提到页面级：它汇总的是**跨卡**风险，
          拆卡后待在某一张卡里就不合适了。 */}
      <RiskSummary status={status} />
      {/* 关于卡置顶（用户指定）。在风险总览**之后**：那一条是告警横幅而非卡片，
          把告警压到卡片下面就失去了意义。 */}
      <AboutGroup status={status} unreadCount={unreadCount} onMarkSeen={onMarkSeen} changelogOpenToken={changelogOpenToken} />
      {/* 其余顺序按「风险 + 改动频率」排（设计稿：design/设置页布局重组-方案A-设计稿.html） */}
      <NetworkGroup status={status} onSaved={onSaved} />
      {/* 防火墙卡片仅 Windows：macOS 的防火墙是**按应用授权**而非按端口开洞，
          且默认不拦本机监听端口的入站连接，整套 netsh 诊断/修复在那里无意义。
          紧跟网络：两者回答的是同一个问题——远程能不能连进来。 */}
      {isWindows(status?.platform) && <FirewallGroup onRefresh={onSaved} />}
      <SecurityGroup status={status} onSaved={onSaved} />
      {/* 紧邻安全卡：它的风险不低于「命令执行」——后者还有三道闸
          （shell_enabled / 危险命令拦截 / 命令白名单），而桥接的 spawn 一道都不走。
          不传 `onSaved`：它自己管自己的刷新，不能挂在全局刷新链上（每改一个
          开关就会把所有 server 的 PATH 扫一遍）。 */}
      <McpBridgeGroup status={status} />
      <BackupAuditGroup status={status} onSaved={onSaved} />
      <NotifyGroup status={status} onSaved={onSaved} />
      <AdvancedGroup status={status} onSaved={onSaved} />
      {/* 紧跟「高级」：终端拖拽即选在那张卡里，终端相关的两项挨着放。
          风格是低频但会回头改的项，故不塞进「装完很少再动」的高级卡。 */}
      <TerminalGroup />
      <AppGroup />
      <InstallGroup platform={status?.platform} onReopenOnboarding={onReopenOnboarding} />
      <ConfigGroup status={status} onSaved={onSaved} />
    </div>
  );
}
