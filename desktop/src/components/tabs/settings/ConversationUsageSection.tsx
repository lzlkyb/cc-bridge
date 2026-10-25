import { useMemo } from "react";
import { invoke } from "../../../lib/tauri";
import { useQuery } from "@tanstack/react-query";
import type { CcSessionUsageRow, TokenUsageSession } from "../../../lib/types";
import { fmtTokens, formatRelativeSecs } from "../../../lib/utils";
import { Icon } from "../../ui/icon";
import { Skeleton } from "../../ui/Skeleton";
import { InfoPopover } from "../../ui/InfoPopover";
import { useAppHidden } from "../../../lib/appVisibility";

/**
 * 「对话消耗」分区（批 2-6 两套账打通）。
 *
 * ## 为什么单独一张表而不是并进上面的 KPI
 *
 * 上面那套（KPI / 趋势 / 热力图 / 排行）是**工具账**：`audit.log` 里每次工具
 * 调用的字节 ÷ 4 估算，口径是「经桥交互的上下文增量」。
 * 这一张是**对话账**：CC CLI 每轮 `result.modelUsage` 上报的真实 token 与成本，
 * 按 session id 落在 `cc_session_usage` 表里。
 *
 * 🔴 **两套账不能相加**。工具账估的字节大体就是对话账里由工具结果贡献的那部分
 *    （是子集），加在一起等于把同一段上下文计两遍。所以这里刻意做成两张表，
 *    并且每行都把两个数并排摆出来让人自己看比例，而不是给一个「总消耗」。
 *
 * ## 为什么没有「今日」口径
 *
 * 对话账按 `updated_at` 取最近 N 条会话，不做按天聚合：一条会话可以跨天聊，
 * 按天切会把一次连续对话劈成两半。要看节奏上面那张工具账的按天视图更合适。
 */

/** 展示最近多少条会话。再多设置页这张卡就压过别的分区了。 */
const SHOW_SESSIONS = 6;

/** 两套账的口径说明。tooltip 与卡底那行共用同一份文案，改一处要连另一边一起改。 */
const ACCOUNTING_NOTE =
  "对话消耗是 CC CLI 每轮上报的真实 token 与成本（按会话累计）；工具消耗是 cc-bridge 按「约 4 字节 ≈ 1 token」对工具调用字节的估算。" +
  "工具结果本来就要进模型上下文，所以工具消耗大体包含在对话消耗里——两者是包含关系，不能相加。";

export function ConversationUsageSection({ toolSessions }: { toolSessions: TokenUsageSession[] }) {
  // 与工具账同一套可见性门控：窗口隐藏 / 不在本视图时停轮询。
  // `useAppHidden()` 内部已 `hidden || !useViewActive()`，这里不必再并一个
  // `useViewActive()`——既冗余，`||` 短路还会让 eslint 判成条件调用 hook。
  const hidden = useAppHidden();
  const { data, isLoading } = useQuery<CcSessionUsageRow[]>({
    queryKey: ["cc-session-usage"],
    queryFn: () => invoke<CcSessionUsageRow[]>("cc_session_usage"),
    // 对话账只在轮次结束时变，30s 轮询足够。
    enabled: !hidden,
    refetchInterval: hidden ? false : 30_000,
  });

  const rows = useMemo(() => {
    const toolById = new Map(toolSessions.map((s) => [s.sessionId, s]));
    return (data ?? [])
      .slice(0, SHOW_SESSIONS)
      .map((r) => ({
        ...r,
        // 标题兜底：Rust 侧已过滤空标题，但 TS 类型允许空串——空名字在表里
        // 就是一格空白，看不出是谁，所以这里再判一次，退回 session id 前 8 位。
        name: r.title?.trim() ? r.title : `${r.sessionId.slice(0, 8)}…`,
        tokens: r.inputTokens + r.outputTokens,
        tool: toolById.get(r.sessionId),
      }));
  }, [data, toolSessions]);

  const total = rows.reduce(
    (a, r) => ({ tokens: a.tokens + r.tokens, cost: a.cost + r.costUsd }),
    { tokens: 0, cost: 0 },
  );

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-xs font-semibold">对话消耗</span>
        <span className="text-[11px] font-medium text-muted-foreground">CC 上报的真实值</span>
        <InfoPopover label="两套账的口径">
          <p>{ACCOUNTING_NOTE}</p>
        </InfoPopover>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          还没有记录到对话用量。在对话页发过消息、并且那一轮正常结束后，这里会出现每条会话的
          token 与成本。
        </p>
      ) : (
        <>
          <div className="usage-conv">
            {/* 表头：五列裸数字没有列名很难读。折叠态由 CSS 收起（列对不上），
                每格 title 仍带口径，不收起来也不丢信息。 */}
            <div className="usage-conv-head" aria-hidden="true">
              <span>会话</span>
              <span>轮次</span>
              <span>token</span>
              <span>成本</span>
              <span>工具(估)</span>
            </div>
            {rows.map((r) => (
              <div className="usage-conv-row" key={r.sessionId}>
                <span className="usage-conv-name" title={r.name}>
                  {r.name}
                </span>
                <span className="usage-conv-turns" title="轮次数">
                  {r.turns} 轮
                </span>
                <span className="usage-conv-tok" title="对话 token（输入+输出，含缓存读取）">
                  {fmtTokens(r.tokens)}
                </span>
                <span className="usage-conv-cost" title="该会话累计成本">
                  ${r.costUsd.toFixed(2)}
                </span>
                <span
                  className="usage-conv-tool"
                  title={
                    r.tool
                      ? `经桥工具调用约 ${fmtTokens(r.tool.estInput + r.tool.estOutput)} token（${r.tool.calls} 次）`
                      : "这个窗口期内没有归属到它的工具调用"
                  }
                >
                  {r.tool ? `~${fmtTokens(r.tool.estInput + r.tool.estOutput)}` : "—"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            最近 {rows.length} 条会话合计 {fmtTokens(total.tokens)} token · ${total.cost.toFixed(2)}
            ，最后更新于 {formatRelativeSecs(rows[0].updatedAt) || "未知"}
          </p>
        </>
      )}

      <div className="mt-2 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2">
        <Icon name="info" size={12} className="mt-0.5 shrink-0 opacity-60" />
        <span className="text-xs leading-relaxed text-muted-foreground">
          <strong className="text-foreground">两套账不能相加</strong>
          ：工具结果本来就要进模型上下文，工具消耗大体包含在对话消耗里。
        </span>
      </div>
    </div>
  );
}
