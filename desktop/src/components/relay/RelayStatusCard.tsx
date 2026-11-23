import { useState } from "react";
import { Icon } from "../ui/icon";
import { formatUptime } from "../../lib/utils";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { formatClock, statusTone, statusText } from "../../lib/relayFormat";
import type { RelaySnapshot } from "../../lib/types";

/**
 * ① 状态主卡（12 列网格的 `1/5`、跨两行）。
 *
 * 面料直接用 `.status-card` 的四套渐变（index.css:782-785）：这一页「跑没跑」
 * 要一眼看出，而全应用里唯一表达这件事的面料就是它。
 * 卡内**所有**颜色走 `--relay-*`（relay.css 顶部定义），因为 classic 是白字压深紫、
 * 玻璃下是深藏青压淡蓝紫，写死 `#fff` 在玻璃下会变成白字压白底。
 */
export function RelayStatusCard({
  snapshot,
  onChanged,
}: {
  snapshot?: RelaySnapshot;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<"start" | "stop" | "restart" | null>(null);
  const [error, setError] = useState("");
  const running = snapshot?.running ?? false;
  const configured = snapshot?.provider?.configured ?? false;
  const provider = snapshot?.provider?.name || "上游";
  const upstream = snapshot?.tiers.find((t) => t.tier === "default")?.upstreamModel ?? "";

  const run = async (kind: "start" | "stop" | "restart") => {
    setPending(kind);
    setError("");
    try {
      if (kind === "stop") await invoke("relay_stop");
      else if (kind === "start") await invoke<string>("relay_start");
      else await invoke<string>("relay_restart");
      toast(kind === "stop" ? "中转已停止，配置与日志都保留" : "中转已就绪", "success");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(null);
    }
  };

  const headline = !running ? "未在监听" : configured ? upstream : "未配置上游";
  const sub = !running
    ? "打开后自动恢复上次的配置，远端不用改文件。"
    : configured
      ? "全部档位都走它。请求到了先改模型名，再原样转发。"
      : "三个值都在你的上游控制台里，别的不用管。";
  const method = !running ? "已关闭" : snapshot?.listenHost === "127.0.0.1" ? "隧道接入" : "内网直连";

  return (
    <div className={`status-card relay-status-card ${running ? "status-card--live" : "status-card--stopped"}`}>
      <div className="relay-eyebrow">
        <span className="dot" />
        <strong>当前中转</strong>
        <span className="relay-method">{method}</span>
      </div>

      <div className="relay-chain">
        <span className="relay-chain-node">
          <Icon name="terminal" size={11} />
          Claude Code
        </span>
        <span className="relay-chain-link" />
        <span className="relay-chain-node" data-cut={!running || undefined}>
          <Icon name="server" size={11} />
          <code>{snapshot?.port ?? 4100}</code>
        </span>
        <span className="relay-chain-link" />
        <span className="relay-chain-node" data-cut={(!running || !configured) || undefined}>
          <Icon name="activity" size={11} />
          {configured ? provider : "未设置"}
        </span>
      </div>

      <p className="relay-status-model">{headline}</p>
      <p className="relay-status-sub">{sub}</p>

      <div className="relay-status-target">
        <Icon name="monitor" size={12} />
        <span>
          {running ? "监听" : "原监听"}{" "}
          <code>
            {snapshot?.addr ?? `${snapshot?.listenHost ?? "127.0.0.1"}:${snapshot?.port ?? 4100}`}
          </code>
        </span>
      </div>

      <details className="relay-status-local">
        <summary>
          本机服务详情
          <Icon name="chevronDown" size={12} />
        </summary>
        <p>
          {running ? `已运行 ${formatUptime(snapshot?.uptimeSecs ?? 0)}` : "关闭期间不监听"}；日志保留最近
          5,000 条，按天存盘。
        </p>
        <p>
          访问令牌{snapshot?.token ? `已启用（${snapshot.tokenMasked}）` : "尚未生成"}
          ，本机与远端共用同一枚。
        </p>
        <p>
          {snapshot?.listenHost === "127.0.0.1"
            ? "隧道模式下中转只绑回环，不对内网暴露——远端经 SSH 隧道照样能访问。"
            : "内网直连会绑到网卡上，同网段可探测，令牌走明文 HTTP。"}
        </p>
      </details>

      <div className="relay-status-actions">
        <button
          type="button"
          className="status-btn status-btn--grow"
          disabled={pending !== null}
          onClick={() => void run(running ? "stop" : "start")}
        >
          <Icon name={pending ? "spinner" : running ? "pause" : "play"} size={13} className={pending ? "animate-spin" : ""} />
          {pending === "stop" ? "停止中…" : pending === "start" ? "启动中…" : running ? "停止中转" : "重新打开中转"}
        </button>
        {running && (
          <button
            type="button"
            className="status-btn status-btn--ghost"
            disabled={pending !== null}
            onClick={() => void run("restart")}
          >
            <Icon name="refresh" size={13} />
            重启
          </button>
        )}
      </div>

      {error && (
        <div className="relay-status-error" role="alert">
          <Icon name="alertTriangle" size={13} />
          <span>{error}</span>
        </div>
      )}

      <div className="relay-mini-act">
        <h6>{running ? "最近请求" : "关闭前的最近请求"}</h6>
        {(snapshot?.recent ?? []).slice(0, 3).map((entry) => (
          <div className="relay-mini-row" key={entry.id}>
            <time>{formatClock(entry.tsMs)}</time>
            <span className="m">{entry.upstreamModel || entry.clientModel}</span>
            <span className="s" data-bad={statusTone(entry.status, entry.error) === "bad" || undefined}>
              {statusText(entry)}
            </span>
          </div>
        ))}
        {(snapshot?.recent?.length ?? 0) === 0 && <div className="relay-mini-row">还没有请求</div>}
      </div>
    </div>
  );
}
