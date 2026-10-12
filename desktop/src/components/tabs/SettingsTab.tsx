import { useEffect, useMemo, useRef, useState } from "react";
import type { StaticStatus } from "../../lib/types";
import { isWindows, shortcutLabel } from "../../lib/platform";
import { SETTINGS_SECTIONS } from "../../lib/settingsSections";
import { FirewallGroup } from "./firewall/FirewallGroup";
import { AboutGroup } from "./AboutGroup";
import { RiskSummary } from "./settings/RiskSummary";
import { SettingsNav } from "./settings/SettingsNav";
import { NetworkGroup } from "./settings/NetworkGroup";
import { SecurityGroup } from "./settings/SecurityGroup";
import { McpBridgeGroup } from "./settings/mcpbridge/McpBridgeGroup";
import { BackupAuditGroup } from "./settings/BackupAuditGroup";
import { TokenUsageGroup } from "./settings/TokenUsageGroup";
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
  onOpenSearch,
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
  /** 打开命令面板（左栏「搜索设置」入口，Ctrl+K 的页面内可见入口）。 */
  onOpenSearch?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 最近一次导航点击的时间戳：其后的程序化 smooth 滚动期间 scrollspy 暂停（见 onScroll）。
  const programmaticScrollAt = useRef(0);
  // 左栏导航当前高亮项（scrollspy：判定线以上最近的卡片）。
  const [activeSection, setActiveSection] = useState<string>(SETTINGS_SECTIONS[0]?.id ?? "");

  // 导航项按平台过滤：防火墙卡仅 Windows 渲染，导航项同步隐藏。
  const sections = useMemo(
    () => SETTINGS_SECTIONS.filter((s) => !s.windowsOnly || isWindows(status?.platform)),
    [status?.platform],
  );

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

  // Scrollspy：滚动时把「判定线（视口内 main 顶部下方 120px）以上最近的卡片」
  // 高亮到左栏。为何不用 IntersectionObserver：多卡同时可见时要自己维护状态表，
  // 且页面滚到底时最后几张卡可能永远进不了判定带，还得补到底兜底——滚动位置
  // 直接算反而更短更直觉。rAF 节流避免每帧 12 次 getBoundingClientRect。
  //
  // ⚠️ `closest("main")` 耦合 App 布局的语义标签：main 是设置页的滚动容器
  // （App.tsx 的 <main className="overflow-y-auto ...">）。若未来重构改掉 main，
  // 这里会静默失效（不报错，只是左栏不再跟随滚动）。
  useEffect(() => {
    const raf = { current: 0 };
    const onScroll = () => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        // 程序化滚动窗口：导航点击后的 smooth 滚动期间不抢高亮（点谁亮谁由
        // handleNavSelect 直接置定）。不区分的话，页面底部「最后一张卡够不到
        // 判定线」的几何会与「点击倒数第二张 / 最后一张」的意图互相矛盾
        // （真实浏览器实测：点 install 被滚到底兜底抢成 config、点 config 被
        // 判定线判成 install，二选一必错一个）。
        if (Date.now() - programmaticScrollAt.current < 1000) return;
        const main = containerRef.current?.closest("main");
        if (!main) return;
        const ids = sections.map((s) => s.id);
        const line = main.getBoundingClientRect().top + 120;
        let current = ids[0] ?? "";
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top <= line) current = id;
        }
        // 滚到底：最后几张卡可能仍够不到判定线，强制高亮最后一项。
        // 前提是内容真的可滚——不足一屏时 scrollTop+clientHeight 恒等 scrollHeight，
        // 不加这个判断会永远高亮最后一项。此兜底只服务**滚轮滚动**（视觉已在页尾，
        // 亮最后一张符合直觉）；导航点击的场景由 handleNavSelect 的程序化滚动窗口
        // 屏蔽 spy，点谁亮谁，不会走到这里。
        if (
          main.scrollHeight > main.clientHeight &&
          main.scrollTop + main.clientHeight >= main.scrollHeight - 4
        ) {
          current = ids[ids.length - 1] ?? current;
        }
        setActiveSection(current);
      });
    };
    const main = containerRef.current?.closest("main");
    main?.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      main?.removeEventListener("scroll", onScroll);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [sections]);

  const handleNavSelect = (id: string) => {
    // 🔴 必须 block:"start" 而非 "center"：scrollspy 判定线是 main 顶下方 120px，
    // center 会把卡**中心**对齐视口中心——卡高 < ~430px 的卡滚完后卡顶仍在线下
    // （940×760 窗口实测：13 项中 7 项），scrollspy 会把高亮判给上一张卡，
    // 观感就是「点了菜单高亮跳回上一项 / 再点没响应」。start 让卡顶停在判定线上方。
    // 同时立即置高亮 + 开 1s 程序化滚动窗口（见 programmaticScrollAt）：页面底部
    // 「最后一张卡够不到判定线」的几何与点击倒数第二/第一张的意图无法用纯几何
    // 同时满足，点击意图优先，滚完窗口过期后 scrollspy 自动接管滚轮。
    // 右列容器的 [&>*]:scroll-mt-2 给卡顶留 8px 呼吸位。
    programmaticScrollAt.current = Date.now();
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div ref={containerRef} className="settings-tab flex items-start gap-4">
      <SettingsNav
        sections={sections}
        activeId={activeSection}
        onSelect={handleNavSelect}
        onOpenSearch={onOpenSearch}
        searchShortcut={shortcutLabel(status?.platform, "K")}
      />
      {/* [&>*]:scroll-mt-2：导航点击 block:"start" 定位时给卡顶留 8px 呼吸位（只作用于本页卡片） */}
      <div className="min-w-0 flex-1 space-y-4 [&>*]:scroll-mt-2">
        {/* 风险总览从原「功能开关」卡内提到页面级：它汇总的是**跨卡**风险，
            拆卡后待在某一张卡里就不合适了。不进左栏导航：它是告警横幅而非设置卡，
            且常驻页面顶部，无需导航。 */}
        <RiskSummary status={status} />
        {/* 关于卡置顶（用户指定）。在风险总览**之后**：那一条是告警横幅而非卡片，
            把告警压到卡片下面就失去了意义。 */}
        <AboutGroup status={status} unreadCount={unreadCount} onMarkSeen={onMarkSeen} changelogOpenToken={changelogOpenToken} />
        {/* 其余顺序按「风险 + 改动频率」排（设计稿：design/设置页布局重组-方案A-设计稿.html）；
            左栏导航顺序与此保持一致（lib/settingsSections.ts）。 */}
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
        {/* 紧跟备份与审计：同为「发生过什么」的回看类信息，数据同源（审计日志）。
            首页 Bento 用量卡点击即落到这里（anchor: set-tokenusage）。 */}
        <TokenUsageGroup />
        <NotifyGroup status={status} onSaved={onSaved} />
        <AdvancedGroup status={status} onSaved={onSaved} />
        {/* 紧跟「高级」：终端拖拽即选在那张卡里，终端相关的两项挨着放。
            风格是低频但会回头改的项，故不塞进「装完很少再动」的高级卡。 */}
        <TerminalGroup />
        <AppGroup />
        <InstallGroup platform={status?.platform} onReopenOnboarding={onReopenOnboarding} />
        <ConfigGroup status={status} onSaved={onSaved} />
      </div>
    </div>
  );
}
