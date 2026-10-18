import { memo, useEffect, useRef } from "react";
import type { StaticStatus } from "../../lib/types";
import { Icon } from "../ui/icon";
import { useConnectGuideState } from "../../hooks/useConnectGuideState";
import { ConnectBento } from "./ConnectBento";
import { IpChangedBanner } from "./connect/IpChangedBanner";
import { MultiDeviceCard } from "./connect/MultiDeviceCard";
import { FirewallAlertBlock } from "./connect/FirewallAlertBlock";
import { isWindows } from "../../lib/platform";
import { ToolGuide } from "./connect/ToolGuide";
import { ConnectGuide } from "./connect/ConnectGuide";
import { invokeOrToast } from "../../lib/tauri";
import type { McpClientTool } from "../../lib/mcpClients";

function ConnectTabImpl({
  status,
  onRefresh,
  selectedIp,
  onSelectIp,
  ipResolvedByUser,
  onSedResolved,
  dismissed,
  onDismissIpChange,
  onNavigate,
  pendingSuspended,
  onSuspendCmd,
  onCopySed,
}: {
  status?: StaticStatus;
  onRefresh: () => void;
  selectedIp: string;
  /**
   * `byUser` 区分「用户主动点选」与「组件自动预选」（审查 B9）。
   * 只有用户主动点选才该置「已处理待复制」——首装自动选第一个 IP 若被当成用户点选，
   * 会立刻弹出「网络地址已变化」橙色横幅，而地址根本没变。
   */
  onSelectIp: (ip: string, byUser?: boolean) => void;
  /** 方案 Q: 用户已点选新地址但未复制远程更新命令的中间态（App 层提升），用于保持 banner 可见 */
  ipResolvedByUser: boolean;
  /** 方案 Q: 复制远程更新 sed 命令后收口，通知 App 清除 ipResolvedByUser */
  onSedResolved: () => void;
  /** 方案 R: 用户点关闭按钮「本次会话忽略此 IP 变化提示」（App 层提升），用于隐藏 banner */
  dismissed?: boolean;
  /** 方案 R: 关闭按钮回调，通知 App 置 ipChangeDismissed=true */
  onDismissIpChange?: () => void;
  /**
   * 跨 Tab 跳转（可带锚点）。与 Header 安全徽章、命令面板同一个 `App.handleNavigate`。
   * Bento 各卡靠它跳到对应的设置项 / 页面；不传则所有卡退化为不可点。
   */
  onNavigate?: (tab: string, anchor?: string) => void;
  /** IP 横幅命令已挂起到顶栏胶囊（App 层 pendingCmd 非空）：横幅整体收起。 */
  pendingSuspended?: boolean;
  /** 倒计时归零且未复制：把命令升级为顶栏挂起胶囊（App 层接住存 pendingCmd）。 */
  onSuspendCmd?: (payload: { ip: string; cmd: string }) => void;
  /** 「复制 IP 替换命令」全局入口（App 层 useIpSedCopy，带横幅/挂起胶囊收口），
   *  透传到 AddressPicker 的「复制命令」按钮——不依赖 IP 变化横幅也能直接复制。
   *  返回 true = 已写入剪贴板（供按钮内联「已复制」反馈）。 */
  onCopySed?: () => boolean | Promise<boolean>;
}) {
  const lanIps = status?.lanIps ?? [];

  // ⑤ 结构收敛：向导的 scope/路径/展开态/命令拼接/复制反馈全部下沉
  // useConnectGuideState（含 ① P0 的 has_onboarded 初始展开），本组件不再透传 18 个 props。
  const guide = useConnectGuideState(status, selectedIp);

  // 链路是否真正中断（红态）：服务在跑，但地址变了或探针不通（远程连不回本机）。
  // 防火墙告警块在链路未中断时才显示——红态优先于橙态，避免叠加制造混乱（设计稿规则）。
  const linkDown =
    !!status && !!status.running && (status.ipChanged || status.remoteReachable === false);

  // 地址变化 banner 显示期间，固化「之前使用的地址」，避免选新地址落盘后
  // lastSelectedIp 变成新地址、把"之前使用"误显示为刚选的新地址（残留 bug 修复）。
  const prevIpRef = useRef<string | null>(null);
  useEffect(() => {
    const show = !!status?.ipChanged || ipResolvedByUser;
    if (show && prevIpRef.current == null) {
      prevIpRef.current =
        status?.lastSelectedIp ??
        (status?.host && status.host !== "0.0.0.0" ? status.host : null);
    } else if (!show) {
      prevIpRef.current = null;
    }
  }, [status?.ipChanged, status?.lastSelectedIp, ipResolvedByUser, status?.host]);

  // 监听全网卡时才需要选 IP；host 指定了具体地址就用它
  const listenAll = status?.host === "0.0.0.0";

  useEffect(() => {
    if (!listenAll || lanIps.length === 0) return;
    // 场景 1：后端从没记录过选中 IP → 默认选第一个（首次接入）。
    // 注意：不能用本地 selectedIp 判断「从未选过」——它每次冷启动都会重置为 ""，
    // 会导致每次启动都把后端 last_selected_ip 覆盖成 lan_ips[0]（物理网卡 IP，永不
    // 消失），从而让 ip_changed 永远无法触发，弱提示全部失效（见诊断报告）。
    if (!selectedIp && !status?.lastSelectedIp) {
      // 🔴 byUser=false：这是**组件自动预选**，不是用户点选（审查 B9）。
      // 传 true 会让 App 置 ipResolvedByUser → 首屏直接弹「网络地址已变化」，
      // 而首次安装根本没有发生过地址变化。
      onSelectIp(lanIps[0], false);
      return;
    }
    // 场景 2：当前选中 IP 已不在网卡列表（地址变化，如 DHCP 续租 / 换网）——
    // 自动预选第一个可用地址作为候选，让 IP 变化 banner 立即给出可复制的 sed 命令；
    // 用户仍可在 AddressPicker 中改选。仅当「当前选中已失效」时触发，绝不覆盖用户
    // 确认过的有效地址（避免静默切换）。
    if (selectedIp && !lanIps.includes(selectedIp)) {
      // 同理：自动候选不是用户点选，不置「已处理」。（此时横幅本来就该显示，
      // 由 status.ipChanged 驱动，不依赖这个标记。）
      onSelectIp(lanIps[0], false);
    }
  }, [listenAll, lanIps.join(","), selectedIp, status?.lastSelectedIp]);

  return (
    <div className="space-y-3 connect-tab">
      {/* 防火墙告警块：是否现身由组件内部根据后端结构化诊断自己判定（无阻塞类问题则返回 null）。
          不再在这里看 firewallPortOpen 布尔值：旧条件在「规则只覆盖 Public / 指向旧路径 / 存在
          Block 规则」这三种常见情形下会假绿，导致用户只能去关整个防火墙。仍保留 linkDown 互斥。 */}
      {/* 仅 Windows：macOS 防火墙按应用授权、默认不拦本机监听端口的入站连接，
          netsh 诊断整套在那里没有对应物。 */}
      {status?.running && !linkDown && isWindows(status.platform) && (
        <FirewallAlertBlock port={status.port} onRefresh={onRefresh} />
      )}

      {/* 防火墙探测不可用（netsh 异常）：温和提示，不弹系统错误框。
          与上方橙色告警互斥——netsh 损坏时 firewallEnabled/portOpen 均为 null，橙色块不会渲染。 */}
      {isWindows(status?.platform) && status?.firewallAvailable === false && (
        <div className="animate-fade-in space-y-2 rounded-lg border border-border bg-secondary/40 p-4">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Icon name="info" size={15} />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">防火墙状态暂不可用</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                无法查询系统防火墙状态（系统 <code className="rounded bg-background px-1">netsh</code> 异常，错误码 0xc0000142）。这<strong>不影响服务运行与远程连接</strong>——仅本机的防火墙探测被停用，以避免反复弹出系统错误框。如需恢复状态显示，请以管理员身份运行 <code className="rounded bg-background px-1">sfc /scannow</code> 修复后重启本应用。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* IP 变化醒目提示：上次确认的 IP 不在本机网卡列表中了（VPN 重连等），引导用户选新地址。
          方案 Q：ipChanged 被乐观清除后，靠 ipResolvedByUser 兜底保持可见，直到用户复制远程更新命令。 */}
      {(status?.ipChanged || ipResolvedByUser) && !dismissed && (
        <IpChangedBanner
          lanIps={lanIps}
          selectedIp={selectedIp}
          previousIp={prevIpRef.current}
          port={status?.port ?? 7823}
          scope={guide.scope}
          projectPath={guide.projectPath}
          tls={guide.tlsEnabled}
          client={(status?.connectClient as McpClientTool | undefined) ?? "claude-code"}
          transport={status?.transport === "sse" ? "sse" : "http"}
          token={status?.token ?? ""}
          multiDevice={!!status?.multiDeviceMode}
          deviceId={status?.deviceId ?? ""}
          onResolved={onSelectIp}
          onSedResolved={onSedResolved}
          onDismiss={onDismissIpChange}
          suspended={pendingSuspended}
          onSuspend={onSuspendCmd}
        />
      )}

      {/* Bento 网格：状态主卡 + 四张指标卡 + 健康/治理 + 接入向导。
          P2-3：向导外壳换 ToolGuide（四工具选择器 + 非 Claude 工具的片段渲染），
          原有 claude-code 内容（scope/steps/token/perm）作为 children 仅在该工具下渲染。 */}
      <ConnectBento
        status={status}
        displayHost={guide.displayHost}
        port={guide.port}
        onChanged={onRefresh}
        onNavigate={onNavigate}
        guide={
          <ToolGuide
            host={guide.displayHost}
            port={guide.port}
            token={guide.token}
            transport={status?.transport === "sse" ? "sse" : "http"}
            tlsEnabled={guide.tlsEnabled}
            defaultTool={(status?.connectClient as McpClientTool | undefined) ?? "claude-code"}
            multiDevice={!!status?.multiDeviceMode}
            deviceId={status?.deviceId ?? ""}
            onToolChange={(t) => {
              // 必须落盘：托盘「复制命令 / 复制 IP」与 IpChangedBanner 都按这个值出内容。
              // 只存在组件本地 state 时，界面选了 Codex、托盘仍会复制一条 claude mcp add。
              // 失败必须可见（审查 U1）：裸 invoke 失败只留一条 unhandled rejection，
              // 用户看到的是「选了 Codex，托盘还是 claude 命令」而毫无线索。
              void invokeOrToast(
                "save_config",
                { patch: { connectClient: t } },
                "切换接入工具失败，托盘命令可能仍是旧工具",
              ).then((r) => {
                if (r) onRefresh();
              });
            }}
          >
            <ConnectGuide
              status={status}
              guide={guide}
              listenAll={listenAll}
              lanIps={lanIps}
              selectedIp={selectedIp}
              onSelectIp={onSelectIp}
              onToggle={guide.toggleSection}
              onRefresh={onRefresh}
              onCopySed={onCopySed}
            />
          </ToolGuide>
        }
      />

      {/* 多设备接入模式（opt-in）：关闭时只渲染开关行、无任何身份 UI，命令形态不变（兼容性契约）。 */}
      <MultiDeviceCard status={status} onChanged={onRefresh} />
    </div>
  );
}

export const ConnectTab = memo(ConnectTabImpl);
