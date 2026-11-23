import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import { InlineNotice } from "../ui/notice";
import { useRelayStatus } from "../../hooks/useRelayStatus";
import { useRelayDraft } from "../../hooks/useRelayDraft";
import { formatClock, formatInt } from "../../lib/relayFormat";
import { RelayStatusCard } from "./RelayStatusCard";
import { RelayMetrics } from "./RelayMetrics";
import { RelayUpstreamCard } from "./RelayUpstreamCard";
import { RelayAliasCard } from "./RelayAliasCard";
import { RelayAccessCard } from "./RelayAccessCard";
import { RelayLogCard } from "./RelayLogCard";
import { RelayTierCard } from "./RelayTierCard";
import { RelayReopenCard } from "./RelayReopenCard";
import "./relay.css";

/**
 * 模型中转页（主界面第 6 个 tab，默认隐藏）。
 *
 * 结构与连接页同源（12 列 / 状态卡 4×2 / 指标各 2 列），内容全部按中转自己的数据重写。
 * 10 块的分工见 `docs/模型中转内置方案-2026-11-23.md` §4.9.2 的对照表。
 *
 * 🔴 **这一页没有总开关**。左侧能不能看到这一页、服务是否监听，都由设置里那一行管
 * （§4.9.1）。页内的「停止中转 / 重启」是服务动作，与连接页顶部那颗启停按钮同性质。
 * 两处总开关必然打架，所以这里一个都不放。
 *
 * 🔴 关闭态与运行态**共用同一套卡片骨架**：状态卡换灰渐变、指标一律 `—`、
 * 配置卡标「待生效」。退回一张居中占位卡会让「配置都还在」这件事不可见。
 */
export function RelayTab({
  onNavigate,
}: {
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const { data: snapshot, series, isError, refetch } = useRelayStatus();
  const form = useRelayDraft(snapshot, () => void refetch());
  const running = snapshot?.running ?? false;
  const configured = snapshot?.provider?.configured ?? false;
  const direct = !!snapshot && snapshot.listenHost !== "127.0.0.1";

  // 空状态即引导（§4.9.2.1）：三格还空着时把焦点放到第一格。
  // 只在**首次读到快照**时做一次——跟着快照跑会在每次轮询时抢焦点，
  // 用户打到一半的字会被光标拽走。
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !snapshot) return;
    focused.current = true;
    if (!snapshot.provider?.configured) {
      document.getElementById("relay-base-url")?.focus();
    }
  }, [snapshot]);

  const badge = !running
    ? { tone: "idle", text: "已关闭" }
    : !configured
      ? { tone: "idle", text: "未配置上游" }
      : direct
        ? { tone: "lan", text: "运行中 · 对内网开放" }
        : { tone: "ok", text: "运行中" };

  const sub = !running
    ? "中转停着，端口上没有监听。配置都还在，重新打开不用再填一遍。"
    : !configured
      ? "还没配上游：Claude Code 的请求先到这里，再由这里送到上游模型。三个值都在你的上游控制台里。"
      : "Claude Code 的请求先到这里，再由这里送到上游模型。本机会话与远端会话共用这一套配置，所以远端只需要两个值：地址和这个名字。";

  const stats = snapshot?.stats;

  return (
    <div className="space-y-3 relay-tab">
      <div className="relay-head">
        <div>
          <div className="relay-head-title">
            <h1>模型中转</h1>
            <span className="relay-badge" data-tone={badge.tone}>
              {badge.text}
            </span>
          </div>
          <p className="relay-head-sub">{sub}</p>
        </div>
        <div className="relay-head-meta">
          上游 <b>{snapshot?.provider?.name || "未设置"}</b>
          <br />
          {running
            ? `今日 ${formatInt(stats?.todayRequests ?? 0)} 次 · 错误 ${formatInt(stats?.todayErrors ?? 0)} 次`
            : "已关闭 · 配置保留"}
          {stats?.lastError && stats.lastErrorAtMs != null && (
            <>
              <br />
              最近错误 {formatClock(stats.lastErrorAtMs)}
            </>
          )}
        </div>
      </div>

      {isError && (
        <InlineNotice variant="warning">
          <b>读不到中转状态。</b>本机服务的状态接口没响应，页面上的数字可能停在最后一次成功的时刻。
          <button type="button" className="relay-mini-btn" onClick={() => void refetch()}>
            重试
          </button>
        </InlineNotice>
      )}

      <div className="bento relay-bento">
        <RelayStatusCard snapshot={snapshot} onChanged={() => void refetch()} />
        <RelayMetrics snapshot={snapshot} series={series} />
        <RelayUpstreamCard snapshot={snapshot} form={form} />
        <RelayAliasCard snapshot={snapshot} form={form} />

        {running ? (
          <>
            <RelayAccessCard snapshot={snapshot} onChanged={() => void refetch()} />
            <RelayLogCard snapshot={snapshot} onNavigate={onNavigate} />
            <RelayTierCard snapshot={snapshot} />
          </>
        ) : (
          <RelayReopenCard />
        )}
      </div>

      {!configured && !running && (
        <p className="relay-head-sub">
          <Icon name="info" size={11} /> 配置卡里的三个值填完并保存后，重新打开中转就能用。
        </p>
      )}
    </div>
  );
}
