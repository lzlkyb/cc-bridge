import { Icon } from "../ui/icon";
import type { RelaySnapshot } from "../../lib/types";
import { formatClock, formatMs, rewriteLabel, sourceLabel, statusText, statusTone } from "../../lib/relayFormat";

/**
 * ⑥ 请求日志（8 列），只放最近 5 条 + 去日志页。
 *
 * 为什么内嵌而不是只给个入口：这一页要回答的是「刚才那一下通了吗」，
 * 而完整回溯（筛选、详情、导出）在日志页已经有一套，不重造（§4.9.2）。
 *
 * ⚠ 「来源」这一列有一个必须写在明面上的局限：**隧道接入的远端请求会显示成「本机」**。
 * 因为 SSH 反向隧道是从本机回环进来的，peer 地址就是 127.0.0.1。所以这一列实际
 * 只能区分「回环 / 内网」，不能区分「谁在用」。写在卡底，不让人据此推断接入方。
 */
export function RelayLogCard({
  snapshot,
  onNavigate,
}: {
  snapshot?: RelaySnapshot;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const rows = (snapshot?.recent ?? []).slice(0, 5);

  return (
    <div className="bento-card relay-log-card">
      <div className="bento-eyebrow relay-card-head">
        <Icon name="log" size={12} />
        <span className="grow">请求日志</span>
        <span className="relay-tail">最近 5 条</span>
        {onNavigate && (
          <button type="button" className="relay-mini-btn" onClick={() => onNavigate("log")}>
            打开日志页
            <Icon name="chevronRight" size={11} />
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="relay-empty">还没有请求经过中转。远端配好后第一条会出现在这里。</div>
      ) : (
        <table className="relay-log-table">
          <thead>
            <tr>
              <th style={{ width: "13%" }}>时间</th>
              <th style={{ width: "11%" }}>来源</th>
              <th style={{ width: "12%" }}>档位</th>
              <th style={{ width: "28%" }}>上游模型</th>
              <th style={{ width: "13%" }}>改写</th>
              <th style={{ width: "11%" }}>状态</th>
              <th style={{ width: "12%" }}>首字</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const tone = statusTone(entry.status, entry.error);
              const rewrite = rewriteLabel(entry.rewrite);
              return (
                <tr key={entry.id} data-inflight={entry.status == null && !entry.error ? true : undefined}>
                  <td className="mono dim">{formatClock(entry.tsMs)}</td>
                  <td title={entry.source}>{sourceLabel(entry.source)}</td>
                  <td className="mono" title={entry.clientModel}>
                    {entry.tier}
                    {entry.fellBack && " · 回落"}
                  </td>
                  <td className="mono" title={entry.upstreamModel}>
                    {entry.upstreamModel}
                  </td>
                  <td>
                    {rewrite ? (
                      <span className="relay-pill" data-tone="fold" title={entry.foldSummary ?? undefined}>
                        {rewrite}
                      </span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td>
                    <span className="relay-pill" data-tone={tone} title={entry.error ?? undefined}>
                      {statusText(entry)}
                    </span>
                  </td>
                  <td className="mono dim">{formatMs(entry.firstByteMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="relay-foot">
        <Icon name="info" size={11} />
        <span>
          「本机」也可能是隧道过来的远端请求——SSH 反向隧道从回环进来，这一列只能区分回环与内网。
          完整明细在日志页。
        </span>
      </div>
    </div>
  );
}
