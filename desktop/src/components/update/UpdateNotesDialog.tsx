import { Icon } from "../ui/icon";
import { Modal } from "../ui/Modal";

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

/** 把 ISO 日期字符串格式化为中文可读格式（如 "2026年7月17日"）。 */
function formatDate(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return "";
  }
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
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-[#6366f1]">
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

/** 「查看更新内容」弹窗 —— v3 排版驱动风格（参考 Linear / Clerk / macOS 更新页）。 */
export function UpdateNotesDialog({
  open,
  update,
  onClose,
  onDownload,
  onDismiss,
}: {
  open: boolean;
  update: { version?: string; body?: string | null; date?: string | null; currentVersion?: string } | null;
  onClose: () => void;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  if (!update) return null;
  const ver = update.version ?? "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      zIndex={1000}
      className="modal-box relative mx-4 w-[488px] max-w-[90vw] overflow-hidden rounded-[20px] modal-surface update-glow before:absolute before:left-0 before:right-0 before:top-0 before:z-10 before:h-[3px] before:bg-gradient-to-r before:from-[#4f46e5] before:to-[#7c3aed] before:content-['']"
    >
        {/* ── 关闭按钮（绝对定位右上角） ── */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-20 flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground interactive hover:bg-accent hover:text-foreground"
        >
          <Icon name="close" size={18} />
        </button>

        {/* ═══ Hero 区（居中布局，带径向渐变光晕） ═══ */}
        <div className="bg-[radial-gradient(120%_85%_at_50%_0%,rgba(99,102,241,0.10),rgba(124,58,237,0.04)_38%,transparent_70%)] px-9 pb-0 pt-9 text-center">
          <div
            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-white bg-gradient-to-br from-[#4f46e5] to-[#7c3aed] shadow-glow-primary-lg"
          >
            <img src="/icon.png" alt="" className="h-8 w-8 object-contain" />
          </div>

          <div
            className="mb-2.5 inline-block rounded-full bg-primary/[0.12] px-3 py-[3px] text-[11px] font-bold tracking-[0.5px] text-primary"
          >
            新版本可用
          </div>

          <div className="mt-1.5 text-[13px] text-muted-foreground">
            {update.date ? formatDate(update.date) : "CC Bridge 软件更新"}
          </div>

          {update.currentVersion && (
            <div className="notes-rise mb-6 mt-4 inline-flex items-center gap-3 rounded-2xl bg-[#f5f5f7] px-4 py-2.5 dark:bg-white/[0.06]">
              <span className="rounded-lg bg-white px-2.5 py-1 text-[15px] font-semibold text-muted-foreground dark:bg-white/[0.10]">
                v{update.currentVersion}
              </span>
              <span className="flex flex-col items-center text-[#4f46e5]">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
                <span className="text-[9px] font-extrabold tracking-[1px]">升级</span>
              </span>
              <span className="relative rounded-xl bg-gradient-to-br from-[#4f46e5] to-[#7c3aed] px-[14px] py-[7px] text-[22px] font-extrabold leading-none tracking-[0.3px] text-white shadow-glow-primary-lg">
                v{ver}
                <span className="absolute -right-2 -top-2 rounded-full bg-[#ff4d4f] px-1.5 py-0.5 text-[9px] font-extrabold leading-none text-white">NEW</span>
              </span>
            </div>
          )}
          {!update.currentVersion && <div className="mb-6 mt-4" />}
        </div>

        {/* ── 分隔线 ── */}
        <div className="mx-9 h-px bg-[linear-gradient(to_right,transparent,hsl(var(--border))_15%,hsl(var(--border))_85%,transparent)]" />

        {/* ═══ 更新内容滚动区 ═══ */}
        <div className="max-h-[320px] overflow-y-auto px-9 pb-0 pt-7">
          <ReleaseNotes body={update.body ?? null} />
        </div>

        {/* 底部轻提示：稍后行为说明 */}
        <div className="px-9 pb-1 pt-3 text-center text-[11px] text-muted-foreground/70">
          点「稍后」后，本版本不再自动弹框；有新版本时仍会提醒你
        </div>

        {/* ═══ 底部操作（下载按钮加 ↓ 图标） ═══ */}
        <div className="flex items-center gap-2.5 px-9 pb-6 pt-2">
          <span className="flex-1 text-xs text-muted-foreground opacity-60">下载完成后自动安装并重启</span>
          <button
            type="button"
            onClick={() => {
              onDismiss();
              onClose();
            }}
            className="rounded-[10px] bg-transparent px-4 py-2.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            稍后
          </button>
          <button
            type="button"
            onClick={() => {
              onDownload();
              onClose();
            }}
            className="inline-flex items-center gap-1.5 rounded-[10px] bg-[hsl(var(--primary))] px-5 py-2.5 text-[13px] font-semibold text-white shadow-glow-primary transition-all hover:-translate-y-px hover:bg-[hsl(243,75%,53%)] hover:shadow-glow-primary-strong"
          >
            <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>
            下载并更新
          </button>
        </div>
    </Modal>
  );
}
