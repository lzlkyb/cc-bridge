import { Icon } from "../ui/icon";

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

/** 章节标题色标（交替使用，修复类用琥珀色）。 */
function sectionDotColor(sectionIdx: number, label: string): string {
  if (/修复|fix/i.test(label)) return "bg-amber-400";
  return sectionIdx % 2 === 0 ? "bg-indigo-400" : "bg-violet-400";
}

/** Release Notes 轻量渲染，支持三种内容格式：
 *  1. `**标题**` 单独一行 → 章节标题（带色标圆点）
 *  2. `- 条目` → 列表项（带圆点 bullet）
 *  3. 纯文本行 → 段落文字
 *  行内 `**加粗**` 自动转为 <strong>。
 */
export function ReleaseNotes({ body }: { body: string | null | undefined }) {
  if (!body || !body.trim()) {
    return <div className="px-1 py-2 text-xs text-muted-foreground">本次更新暂无说明</div>;
  }

  const lines = body.split("\n");
  let sectionIdx = 0;

  return (
    <div className="flex flex-col">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (line.trim() === "") return <div key={i} className="h-2" />;

        // 整行 **...** → 章节标题
        const headerMatch = line.match(/^\*\*(.+)\*\*$/);
        if (headerMatch) {
          const label = headerMatch[1].trim();
          const dotCls = sectionDotColor(sectionIdx, label);
          sectionIdx++;
          return (
            <div key={i} className="mb-1.5 mt-3 flex items-center gap-2 text-xs font-bold text-foreground tracking-[0.3px] first:mt-0">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-[3px] ${dotCls}`} />
              {renderBold(label)}
            </div>
          );
        }

        // 列表项
        const itemMatch = line.match(/^\s*[-*]\s+(.*)$/);
        if (itemMatch) {
          return (
            <div key={i} className="relative py-[3px] pl-4 text-[13px] leading-[1.55] text-muted-foreground">
              <span className="absolute left-0 top-[9px] h-[5px] w-[5px] rounded-full bg-[#d2d2d7]" />
              {renderBold(itemMatch[1])}
            </div>
          );
        }

        // 普通段落
        return (
          <div key={i} className="py-[2px] text-[13px] leading-[1.55] text-muted-foreground">
            {renderBold(line)}
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
}: {
  open: boolean;
  update: { version?: string; body?: string | null } | null;
  onClose: () => void;
  onDownload: () => void;
}) {
  if (!open || !update) return null;
  const ver = update.version ?? "";

  return (
    <div
      className="modal-overlay fixed inset-0 z-[1000] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="modal-box relative mx-4 w-[488px] max-w-[90vw] overflow-hidden rounded-[20px] modal-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 关闭按钮（绝对定位右上角） ── */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon name="close" size={18} />
        </button>

        {/* ═══ Hero 区（居中布局） ═══ */}
        <div className="px-9 pb-0 pt-9 text-center">
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

          <div className="text-[36px] font-extrabold leading-none tracking-[-0.5px] text-foreground">
            v{ver}
          </div>
          <div className="mt-1.5 text-[13px] text-muted-foreground">CC Bridge 软件更新</div>
          <div className="mt-4 mb-6 inline-flex items-center gap-2 text-xs text-[#aeaeb2]">
            <span className="rounded-md bg-muted px-2 py-0.5 text-[11px]">v2.3.1 → v{ver}</span>
            <span className="text-[#d2d2d7]">·</span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[11px]">约 14 MB</span>
          </div>
        </div>

        {/* ── 分隔线 ── */}
        <div className="mx-9 h-px bg-[linear-gradient(to_right,transparent,hsl(var(--border))_15%,hsl(var(--border))_85%,transparent)]" />

        {/* ═══ 更新内容滚动区 ═══ */}
        <div className="max-h-[320px] overflow-y-auto px-9 pb-0 pt-7">
          <ReleaseNotes body={update.body ?? null} />
        </div>

        {/* ═══ 底部操作 ═══ */}
        <div className="flex items-center gap-2.5 px-9 pb-6 pt-4">
          <span className="flex-1 text-xs text-muted-foreground opacity-60">下载完成后自动安装并重启</span>
          <button
            type="button"
            onClick={onClose}
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
            className="rounded-[10px] bg-[hsl(var(--primary))] px-5 py-2.5 text-[13px] font-semibold text-white shadow-glow-primary transition-all hover:-translate-y-px hover:bg-[hsl(243,75%,53%)] hover:shadow-glow-primary-strong"
          >
            下载并更新
          </button>
        </div>
      </div>
    </div>
  );
}
