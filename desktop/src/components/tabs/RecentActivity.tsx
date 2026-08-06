import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { AuditEntry } from "../../lib/types";
import { toolLabel, formatDurationMs } from "../../lib/utils";
import { useAppHidden } from "../../lib/appVisibility";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";

/**
 * 状态主卡底部的「最近活动」三行。
 *
 * 🔴 **为何用 `get_recent_activity` 而不是 `get_audit_log`**：后者的解析缓存键含
 * mtime/len，而审计是追加写——远程一活跃就次次缓存未命中，每次都全量重解析
 * 整个 audit.log（实测基准 4898 条 / 5.2MB）。连接页是默认停留页，按 5s 轮询
 * 会把它变成持续开销。`get_recent_activity` 只 seek 读文件末尾 8KB，成本与日志规模无关。
 * 详见 `audit::read_recent_tail` 头注释。
 *
 * 轮询挂在 5s（与 status 同频），并受 `useAppHidden()` 控制——窗口不可见就停。
 */
export function RecentActivity({ onViewAll }: { onViewAll?: () => void }) {
  const appHidden = useAppHidden();
  const { data } = useQuery<AuditEntry[]>({
    queryKey: ["recentActivity"],
    queryFn: () => invoke<AuditEntry[]>("get_recent_activity", { n: 3 }),
    refetchInterval: appHidden ? false : 5000,
  });

  const rows = data ?? [];
  // 新审计进来时给行列表做 FLIP 过渡（新行淡入 / 剩下的行平滑下移 / 被挤掉的行淡出）。
  // 不加就是整表瞬变：剩下的行直接跳到新位置、掉队的那行凭空消失。
  // 用项目已有的 `useAutoAnimateRM`（审计日志表同一个），它自带减弱动效开关。
  const listRef = useAutoAnimateRM<HTMLDivElement>();

  return (
    // pt-4 是关键：`mt-auto` 只在卡片有富余高度时才把本区顶到底部，没富余时它等于 0，
    // 分隔线会直接贴上启停按钮的底边。用内边距而不是外边距：外边距会与 mt-auto 打架。
    <div className="mt-auto flex flex-col gap-0.5 pt-4">
      {/* 渐变分隔线：中段可见、两端渐隐。整幅实线（原本的 border-t）压在渐变卡上
          对比度偏高、显得很“硬”；与卡内其它分隔处理保持一致。 */}
      <div className="mb-2 h-px bg-gradient-to-r from-transparent via-white/[0.14] to-transparent" />
      <div className="flex items-center text-[9px] font-bold tracking-[0.12em] opacity-90">
        最近活动
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="ml-auto text-[10px] font-bold tracking-normal underline-offset-2 hover:underline"
          >
            日志页查看全部 →
          </button>
        )}
      </div>
      {/* 列表单独包一层：auto-animate 只管**直接子元素**的增删移，
          若把 ref 挂到外层（还包含分隔线与标题行），那两个不变的元素也会被纳入计算。 */}
      <div ref={listRef} className="flex flex-col gap-0.5">
        {rows.length === 0 ? (
          // 中性空态：没有记录不是错误，首次启动就是这个样子。
          <p className="py-1 text-[10.5px] opacity-75">还没有调用记录</p>
        ) : (
          rows.map((e) => (
            // 🔴 key 绝不能带索引：插入一条新审计时所有行的 i 都会变 → 整列表重挂，
            // auto-animate 会把它当成“全部删了又全部新增”，变成整片闪。
            // 用 timestamp+tool 做身份，只有真正的新条目才算新增。
            //
            // 不再加 `animate-fade-in`：auto-animate 自己就会做入场，两套叠一起反而乱。
            <div
              key={`${e.timestamp}-${e.tool}`}
              className="flex items-center gap-1.5 py-px text-[10.5px]"
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  e.success ? "bg-success" : "bg-destructive"
                }`}
              />
              {/* 中文操作名，与日志页同一个 `toolLabel()` 映射，保证两处叫法一致。
                  不给它 font-mono：等宽字体下 CJK 既偏宽也难看，而参数（路径/命令）才需要等宽。
                  title 给原始工具 id，排查时鼠标悬停就能看到英文名。 */}
              <span className="w-[68px] shrink-0 truncate font-semibold" title={e.tool}>
                {toolLabel(e.tool)}
              </span>
              {/* min-w-0 必须有：flex 子项默认 min-width:auto，不置 0 会被长参数撑破卡片。 */}
              <span className="min-w-0 flex-1 truncate font-mono opacity-95">{summarize(e)}</span>
              {/* 用 formatDurationMs 而不是拼 `${ms}ms`：它是日志页同一个格式化函数，
                  输出中文单位并自动换算（微秒/毫秒/秒/分），两处叫法一致。 */}
              <span className="shrink-0 font-mono tabular-nums opacity-90">
                {e.durationMs != null ? formatDurationMs(e.durationMs) : "—"}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * 把一条审计压成一行能看的摘要。
 *
 * 失败的条目优先显示错误原因（那才是用户要看的）；成功的则从参数里抽一个
 * 最能代表“对什么做了什么”的字段。参数是 JSON 字符串，解析失败就直接展原文
 * （截断交给 CSS 的 truncate，这里不手动切——手动切会在不同宽度下要么早截要么溢出）。
 */
function summarize(e: AuditEntry): string {
  if (!e.success && e.error) return e.error;
  try {
    const p = JSON.parse(e.params) as Record<string, unknown>;
    // 按“最能说明问题”排序，命中即返回。
    for (const k of ["path", "file_path", "pattern", "command", "rootPath", "root_path"]) {
      const v = p[k];
      if (typeof v === "string" && v) return v;
    }
    // files / paths 这类数组：报首项 + 余下几个。
    for (const k of ["files", "paths"]) {
      const v = p[k];
      if (Array.isArray(v) && v.length > 0) {
        const first = typeof v[0] === "string" ? v[0] : JSON.stringify(v[0]);
        return v.length > 1 ? `${first} 等 ${v.length} 个` : first;
      }
    }
    return e.params;
  } catch {
    return e.params;
  }
}
