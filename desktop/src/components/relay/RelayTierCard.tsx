import { Icon } from "../ui/icon";
import type { RelaySnapshot } from "../../lib/types";
import { formatInt, tierShare } from "../../lib/relayFormat";

/**
 * ⑦ 档位分布（4 列）。
 *
 * 灰条 = **该档没配**，落到了 `default`。这条语义必须写在卡底：只配一档时三条全灰，
 * 不解释的话第一眼会被读成「我配错了」。反过来，**配了 haiku 却全是灰的**，
 * 说明远端那份文件里的映射名抄错了——这是这张卡最有用的一个诊断。
 *
 * 数据来自今日聚合（`stats.tierHits`），不是序列：这里回答的是「请求落在哪档」，
 * 属于运行数据，与映射名卡（配置）分开。
 */
export function RelayTierCard({ snapshot }: { snapshot?: RelaySnapshot }) {
  const total = snapshot?.stats.todayRequests ?? 0;
  const tiers = snapshot?.tiers ?? [];

  return (
    <div className="bento-card relay-tier-card">
      <div className="bento-eyebrow relay-card-head">
        <Icon name="list" size={12} />
        <span className="grow">档位分布</span>
        <span className="relay-tail">今日 {formatInt(total)} 次</span>
      </div>

      <div className="relay-hits">
        {tiers.map((tier) => {
          const hit = snapshot?.stats.tierHits.find((h) => h.tier === tier.tier);
          const count = hit?.count ?? 0;
          const share = tierShare(count, total);
          return (
            <div className="relay-hit" key={tier.tier} data-fallback={!tier.configured || undefined}>
              <span title={`${tier.tier} → ${tier.upstreamModel || "未配置"}`}>{tier.tier}</span>
              <span className="bar">
                <i style={{ width: `${Math.min(100, Math.max(share, count > 0 ? 2 : 0))}%` }} />
              </span>
              <span className="n">{total > 0 ? `${share.toFixed(0)}%` : "—"}</span>
            </div>
          );
        })}
        {tiers.length === 0 && <div className="relay-empty">还没有读到档位配置</div>}
      </div>

      <div className="relay-foot">
        <Icon name="info" size={11} />
        <span>
          灰条 = 该档没配，请求落到 <code>default</code>。配了却全灰，说明远端映射名抄错了。
        </span>
      </div>
    </div>
  );
}
