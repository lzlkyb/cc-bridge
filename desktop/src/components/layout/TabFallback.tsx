import { Skeleton } from "../ui/Skeleton";

/** 懒加载 Tab 的占位骨架（2026-11-06 从「一刀切两块灰块」改成按页取形）。
 *
 *  为何要分档：各页首屏结构差异极大 —— 终端是满屏终端、对话是左列表 + 右消息流、
 *  日志是筛选条 + 七列表格、连接/安全/设置是 KPI 网格 + 卡片。统一画两块圆角灰块时，
 *  切过去会先看到两张「浅灰卡片」再整块变形，比不画更刺眼。
 *
 *  - `cards`：连接 / 安全 / 设置
 *  - `table`：日志（列宽照抄 LogTab 的真实表头：74/124/1fr/100/64/64/36）
 *  - `split`：对话（左会话列表 220px + 右消息流）
 *  - `blank`：终端 —— 什么都不画。终端配色有 6 套、背景从 #ffffff 到 #0b110b，
 *    画任何固定底色都会在某个配色下变成「错的一跳」，空白反而最安全；再加上
 *    App.tsx 的闲时预取，这一档基本不会出现。
 *
 *  只画块、不画字：骨架期间字体/数据都未就绪，画出来的文字反而会跳。 */
export type TabFallbackKind = "cards" | "table" | "split" | "blank";

const TABLE_COLS = "74px 124px minmax(0,1fr) 100px 64px 64px 36px";

/** 七列行骨架：列宽与 LogTab 的真实表头逐列对应（时间/操作/参数摘要/来源/耗时/状态/详情）。
 *  日志页数据加载也复用它 —— 两处要么同源，要么迟早又对不上。 */
export function TableRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div>
      <div
        className="grid items-center gap-2 border-b border-border/60 pb-2"
        style={{ gridTemplateColumns: TABLE_COLS }}
      >
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-2" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className="grid items-center gap-2 py-[7px]"
          style={{ gridTemplateColumns: TABLE_COLS }}
        >
          {Array.from({ length: 7 }, (_, c) => (
            <Skeleton key={c} className="h-2.5" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function TabFallback({ kind }: { kind: TabFallbackKind }) {
  if (kind === "blank") return null;

  if (kind === "table") {
    return (
      <div className="space-y-3 p-1" aria-hidden="true">
        <div className="flex gap-2">
          <Skeleton className="h-[26px] w-24 rounded-[7px]" />
          <Skeleton className="h-[26px] w-24 rounded-[7px]" />
          <Skeleton className="h-[26px] w-36 rounded-[7px]" />
        </div>
        <TableRowsSkeleton rows={8} />
      </div>
    );
  }

  if (kind === "split") {
    return (
      <div className="flex h-full gap-3 p-1" aria-hidden="true">
        <div className="w-[220px] shrink-0 space-y-2 border-r border-border/60 pr-3">
          <Skeleton className="h-[26px] rounded-[7px]" />
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-3.5" />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-4 pt-1">
          {[70, 52, 64].map((w, i) => (
            <div key={i} className="flex gap-2.5">
              <Skeleton className="h-[26px] w-[26px] shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
                <Skeleton className="h-2.5" style={{ width: `${w - 14}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-1" aria-hidden="true">
      <Skeleton className="h-2.5 w-[140px]" />
      <div className="grid grid-cols-4 gap-2.5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-[11px] border border-border p-3">
            <Skeleton className="h-2 w-11" />
            <Skeleton className="mt-2 h-4 w-16" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}
