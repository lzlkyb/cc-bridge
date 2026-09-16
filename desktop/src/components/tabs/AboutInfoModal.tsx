import { useEffect, type CSSProperties } from "react";
import { Icon } from "../ui/icon";
import { APP_INFO } from "../../lib/about";
import { aboutCopy } from "../../lib/platform";

/**
 * 「关于 CC Bridge」弹窗。
 *
 * 2026-09-16：从 AboutGroup.tsx 原位抽出。它是自成一体的独立弹窗（遮罩 + Esc 关闭 +
 * 固定文案），原来内联在那个 495 行的组件里，既撑破了体量棘轮基线，也让「关于卡」
 * 的展开态布局与「了解一下这个软件」的说明内容混在一个函数里。
 */

/** 弹框内核心能力数据 */
const HIGHLIGHTS = [
  { label: "文件读写 / 搜索", color: "var(--color-primary)" },
  { label: "命令执行与管理", color: "var(--color-success)" },
  { label: "Notebook 编辑 (.ipynb)", color: "#F59E0B" },
  { label: "路径白名单安全校验", color: "#EF4444" },
];

const STYLE_VERSION_BADGE_LG: CSSProperties = {
  background: "var(--version-gradient)",
  boxShadow: "0 3px 10px var(--version-shadow)",
};

export function AboutInfoModal({
  open,
  onClose,
  platform,
}: {
  open: boolean;
  onClose: () => void;
  /** 决定统计口径与两条卖点的平台差异（见 lib/platform.ts 的 aboutCopy）。 */
  platform?: string;
}) {
  // Esc 关闭（项目内 Modal/ConfirmDialog 均有此行为，补齐一致性）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 统计口径（安装包体积、内存、进程隔离机制）在 Windows 与 macOS 上都不一样，
  // 所以放在这里算、由 platform 决定，而不是写死在文案里。
  const about = aboutCopy(platform);

  return (
    <div
      className="modal-overlay fixed inset-0 z-[1000] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="modal-box mx-4 max-h-[80vh] w-[480px] max-w-[90vw] overflow-y-auto rounded-2xl border border-border p-7 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="modal-header mb-[18px] flex items-center justify-between">
          <div className="flex items-center gap-2.5 text-lg font-extrabold text-foreground">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg text-base text-white"
              style={STYLE_VERSION_BADGE_LG}
            >
              <img src="/icon.png" alt="" className="h-5 w-5 object-contain" />
            </div>
            {APP_INFO.name}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground interactive hover:bg-accent hover:text-foreground"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* 正文 */}
        <div className="modal-body text-[13px] leading-relaxed text-muted-foreground">
          <p className="mb-3.5">
            {APP_INFO.name} 是一款轻量级桌面应用，基于 <strong className="text-foreground">Tauri 2 + Rust</strong> 构建。
            它为 AI 编程助手提供标准的 MCP（Model Context Protocol）本地文件系统桥接服务，
            让 AI 能够安全地读写文件、搜索内容、执行命令。
          </p>

          <div className="section-label mb-2.5 ui-eyebrow">核心能力</div>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {HIGHLIGHTS.map((h) => (
              <div key={h.label} className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2 text-xs font-semibold text-foreground">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: h.color }} />
                {h.label}
              </div>
            ))}
          </div>

          <div className="section-label mb-2.5 ui-eyebrow">特色优势</div>
          <p className="mb-2.5 text-xs leading-relaxed">
            · <strong className="text-foreground">极轻量：</strong>{about.lightweight}<br/>
            · <strong className="text-foreground">全离线：</strong>无需网络，纯本地运行，数据不出设备<br/>
            · <strong className="text-foreground">安全沙箱：</strong>{about.sandbox}<br/>
            · <strong className="text-foreground">标准协议：</strong>兼容 Cursor / Claude / VS Code 等 MCP 客户端<br/>
            · <strong className="text-foreground">MIT 开源：</strong>完全免费，代码透明可审计
          </p>

          <div className="modal-stats flex gap-5 divider-x-top pt-3">
            {about.stats.map((s) => (
              <div key={s.label} className="flex flex-1 flex-col items-center text-center">
                <div className="text-lg font-extrabold text-foreground">{s.val}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
