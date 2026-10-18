import { Modal } from "../ui/Modal";
import { UpdateDialogContent } from "./UpdateDialogContent";
import type { UpdateNotesInfo } from "../../lib/updateNotes";

/** 将文本中的 **...** 转换为 <strong> 标签，其余保持纯文本。 */
function renderBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-foreground/90">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}


/** 分类标题的视觉元数据：品类色 + 左侧色条 + bullet + 语义图标。 */
const CAT_META: Record<string, {
  color: string;
  border: string;
  bullet: string;
  icon: React.ReactNode;
}> = {
  "新增": {
    color: "text-indigo-400", border: "border-l-indigo-400", bullet: "bg-indigo-400",
    icon: <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  },
  "修复": {
    color: "text-amber-400", border: "border-l-amber-400", bullet: "bg-amber-400",
    icon: <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round"><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" /></svg>,
  },
  "变更": {
    color: "text-violet-400", border: "border-l-violet-400", bullet: "bg-violet-400",
    icon: <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 9a6 6 0 016-6 6 6 0 014 2M16 7v4h-4" /><path d="M16 15a6 6 0 01-6 6 6 6 0 01-4-2M4 17v-4h4" /></svg>,
  },
  "优化": {
    color: "text-emerald-400", border: "border-l-emerald-400", bullet: "bg-emerald-400",
    icon: <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round"><path d="M11 2L4 12h6l-1 10 8-12h-6z" /></svg>,
  },
  "安全": {
    color: "text-rose-400", border: "border-l-rose-400", bullet: "bg-rose-400",
    icon: <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /></svg>,
  },
};

type NoteBlock =
  | { type: "summary"; text: string }
  | { type: "cat"; label: string; items: string[] };

/** 解析 CHANGELOG 抽取出的 notes 文本为结构化块（摘要 + 各分类条目）。 */
function parseReleaseNotes(body: string): { blocks: NoteBlock[]; counts: Record<string, number> } {
  const blocks: NoteBlock[] = [];
  const counts: Record<string, number> = {};
  let cur: Extract<NoteBlock, { type: "cat" }> | null = null;
  let pendingSummary = false;

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;

    const md = line.match(/^###\s+(.+)$/);
    if (md) {
      const label = md[1].trim();
      if (label === "更新摘要") { pendingSummary = true; cur = null; continue; }
      cur = { type: "cat", label, items: [] };
      counts[label] = 0;
      blocks.push(cur);
      continue;
    }
    if (pendingSummary) {
      blocks.push({ type: "summary", text: line });
      pendingSummary = false;
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item && cur) {
      cur.items.push(item[1]);
      counts[cur.label] = (counts[cur.label] ?? 0) + 1;
    }
  }
  return { blocks, counts };
}

/** Release Notes 渲染：顶部「本次更新」高亮摘要卡 + 统计徽章行 + 分类卡片
 *  （品类色竖条 + 图标标题 + 编号列表）。与更新弹框设计稿（①+②+A + 1动效 + 2暗色 + 3色板）一致。
 *  各内容块带 notes-rise 错落入场动效（delay 递增），prefers-reduced-motion 时自动降级（见 index.css）。 */
export function ReleaseNotes({ body }: { body: string | null | undefined }) {
  if (!body || !body.trim()) {
    return <div className="px-1 py-2 text-xs text-muted-foreground">本次更新暂无说明</div>;
  }

  const { blocks, counts } = parseReleaseNotes(body);
  const catKeys = Object.keys(counts).filter((k) => counts[k] > 0);
  let statRendered = false;
  let animIdx = 0;

  return (
    <div className="flex flex-col">
      {blocks.map((b, i) => {
        if (b.type === "summary") {
          return (
            <div
              key={i}
              className="notes-rise mb-3 mt-0.5 rounded-xl border-l-[3px] border-[#6366f1] bg-[#4f46e5]/[0.07] px-3.5 py-2.5 dark:bg-[#4f46e5]/[0.16]"
              style={{ animationDelay: `${animIdx++ * 0.07}s` }}
            >
              <div className="mb-1 flex items-center gap-1.5 text-xs font-bold tracking-wide text-[#6366f1]">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" /></svg>
                本次更新
              </div>
              <div className="text-[13px] leading-[1.6] text-foreground">{renderBold(b.text)}</div>
            </div>
          );
        }

        const meta = CAT_META[b.label];
        const stat =
          !statRendered && catKeys.length
            ? (
              <div key="stat" className="notes-rise mb-3 flex flex-wrap gap-2" style={{ animationDelay: `${animIdx++ * 0.07}s` }}>
                {catKeys.map((k) => {
                  const cm = CAT_META[k];
                  return (
                    <span key={k} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-foreground">
                      <span className={`h-1.5 w-1.5 rounded-full ${cm?.bullet ?? "bg-[#d2d2d7]"}`} />
                      <span className="text-muted-foreground">{k}</span>
                      <span>{counts[k]}</span>
                    </span>
                  );
                })}
              </div>
            )
            : null;
        if (stat) statRendered = true;

        return (
          <div key={i}>
            {stat}
            <div
              className={`notes-rise mb-2.5 rounded-xl border border-border border-l-[3px] ${meta?.border ?? "border-l-indigo-400"} bg-card/70 py-2.5 pl-3 pr-3 dark:bg-white/[0.05] dark:border-white/10`}
              style={{ animationDelay: `${animIdx++ * 0.07}s` }}
            >
              <div className={`mb-1 flex items-center gap-2 text-[12.5px] font-semibold ${meta?.color ?? "text-foreground"}`}>
                {meta?.icon}
                <span>{b.label}</span>
              </div>
              {b.items.map((it, j) => (
                <div key={j} className="relative py-[3px] pl-4 text-[13px] leading-[1.5] text-muted-foreground">
                  <span className={`absolute left-1 top-[10px] h-[5px] w-[5px] rounded-full ${meta?.bullet ?? "bg-[#d2d2d7]"}`} />
                  <span className="mr-1 text-muted-foreground/70">{j + 1}.</span>
                  {renderBold(it)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 更新下载行为沿用现有通道；展示层单独解析版本范围。 */
export function UpdateNotesDialog({ open, update, onClose, onDownload, onDismiss }: {
  open: boolean;
  update: UpdateNotesInfo | null;
  onClose: () => void;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  if (!update) return null;
  return <Modal open={open} onClose={onClose} zIndex={1000} ariaLabel="CC Bridge 软件更新" className="modal-surface update-dialog">
    <UpdateDialogContent key={`${update.currentVersion ?? ""}/${update.version ?? ""}`} update={update} onClose={onClose} onDownload={onDownload} onDismiss={onDismiss} />
  </Modal>;
}
