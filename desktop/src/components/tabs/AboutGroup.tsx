import { useState, type CSSProperties } from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { useUpdate, type UpdateStatus } from "../../contexts/UpdateContext";
import type { StatusResponse } from "../../lib/types";
import { formatVersion } from "../../lib/utils";
import { APP_INFO, CHANGELOG, CATEGORY_LABELS, type ChangeCategory } from "../../lib/about";
import { openUrl } from "@tauri-apps/plugin-opener";

/** category → Tailwind 类后缀 */
const CATEGORY_CLASS: Record<ChangeCategory, string> = {
  feat: "cl-badge-feat",
  improve: "cl-badge-improve",
  fix: "cl-badge-fix",
  sec: "cl-badge-sec",
};

/** 技术栈数据 */
const TECH_STACK = [
  { icon: "⚙️", name: "Tauri 2", desc: "桌面框架", bg: "rgba(255,193,49,0.12)", color: "#FFC131" },
  { icon: "⚛️", name: "React", desc: "UI 框架", bg: "rgba(97,218,251,0.12)", color: "#61DAFB" },
  { icon: "TS", name: "TypeScript", desc: "类型安全", bg: "rgba(49,120,198,0.12)", color: "#3178C6" },
  { icon: "🦀", name: "Rust", desc: "后端核心", bg: "rgba(222,165,132,0.12)", color: "#DEA584" },
  { icon: "🔌", name: "MCP", desc: "模型上下文", bg: "rgba(99,102,241,0.12)", color: "#6366F1" },
  { icon: "⚡", name: "Vite", desc: "构建工具", bg: "rgba(100,108,255,0.12)", color: "#646CFF" },
];

/** 弹框内核心能力数据 */
const HIGHLIGHTS = [
  { label: "文件读写 / 搜索", color: "var(--color-primary)" },
  { label: "命令执行与管理", color: "var(--color-success)" },
  { label: "Notebook 编辑 (.ipynb)", color: "#F59E0B" },
  { label: "路径白名单安全校验", color: "#EF4444" },
];

/** 弹框统计数据 */
const STATS = [
  { val: "3.4 MB", label: "安装包大小" },
  { val: "< 20 MB", label: "运行时内存" },
  { val: "17 个", label: "MCP 工具" },
];

// E-P2-7: 把内联 style 对象提取为模块级常量，避免每次渲染重建（约 15 处）。
const STYLE_VERSION_BADGE: CSSProperties = { background: "var(--version-gradient)", boxShadow: "0 2px 6px var(--version-shadow)" };
const STYLE_VERSION_BADGE_LG: CSSProperties = { background: "var(--version-gradient)", boxShadow: "0 3px 10px var(--version-shadow)" };
const STYLE_ICON_INDIGO: CSSProperties = { background: "rgba(99,102,241,0.12)", color: "var(--color-primary)" };
const STYLE_ICON_GREEN: CSSProperties = { background: "rgba(22,163,74,0.12)", color: "#16A34A" };
const STYLE_ICON_ORANGE: CSSProperties = { background: "rgba(245,158,11,0.12)", color: "#F59E0B" };
const STYLE_ICON_ACCENT: CSSProperties = { background: "hsl(var(--accent))", color: "var(--color-primary)" };
const STYLE_CL_VERSION_BAR: CSSProperties = { background: "hsl(var(--accent))" };
const STYLE_CL_CAPSULE: CSSProperties = { background: "var(--color-primary)" };
const STYLE_CL_CAPSULE_MUTED: CSSProperties = { background: "var(--color-muted)" };
const STYLE_CL_ITEM_PAD: CSSProperties = { paddingLeft: 28 };
const STYLE_INFO_KEY: CSSProperties = { minWidth: 52 };
const STYLE_MODAL_OVERLAY: CSSProperties = { background: "rgba(0,0,0,0.45)" };
const STYLE_MODAL_BOX: CSSProperties = { background: "var(--color-card)" };
const STYLE_CL_DATE: CSSProperties = { minWidth: 40 };

export function AboutGroup({ status }: { status?: StatusResponse }) {
  const { status: updateStatus, update, checkForUpdate, downloadAndInstall, restart } = useUpdate();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [showMoreHistory, setShowMoreHistory] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const openRepo = async () => {
    try {
      await openUrl(APP_INFO.repoUrl);
    } catch (e) {
      toast(`无法打开浏览器：${String(e)}`, "error");
    }
  };

  return (
    <>
      <Card className="about-card overflow-hidden">
        {/* ═══ 收起态头部（始终可见） ═══ */}
        <button
          type="button"
          className="about-collapsed flex w-full cursor-pointer items-center gap-3 px-[18px] py-3.5 text-left select-none"
          onClick={() => setExpanded(!expanded)}
        >
          {/* 图标 */}
          <img src="/icon.png" alt="" className="h-10 w-10 shrink-0 rounded-lg object-contain" />

          {/* 名称 + 版本 + 状态 */}
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="text-[15px] font-bold text-foreground">{APP_INFO.name}</span>
            <span
              className="inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide text-white"
              style={STYLE_VERSION_BADGE}
            >
              {formatVersion(status?.version)}
            </span>
            <UpdateStatusPill status={updateStatus} update={update} />
          </div>

          {/* 操作按钮区（阻止冒泡，不触发展开） */}
          <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <UpdateActionBtn status={updateStatus} onCheck={checkForUpdate} onDownload={downloadAndInstall} onRestart={restart} />
            <button
              type="button"
              onClick={openRepo}
              className="github-btn flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              title="GitHub 项目主页"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </button>
          </div>

          {/* 展开箭头 */}
          <div className={`expand-chevron flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>
            <Icon name="chevronDown" size={16} />
          </div>
        </button>

        {/* ═══ 展开态内容 ═══ */}
        {expanded && (
          <div className="about-expanded">
            <div className="about-divider h-px bg-border" />

            {/* 技术栈 + 项目信息 双列 */}
            <div className="grid grid-cols-2">
              {/* 左：技术栈 3×2 */}
              <div className="dual-left border-r border-border px-[22px] py-3.5">
                <div className="section-label mb-2.5 text-[10px] font-bold tracking-[0.8px] uppercase text-muted-foreground">技术栈</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {TECH_STACK.map((t) => (
                    <div
                      key={t.name}
                      className="flex flex-col items-center gap-1 rounded-lg border border-transparent bg-muted px-1.5 py-2.5 text-center transition-all hover:translate-y-[-1px] hover:border-border"
                    >
                      <div
                        className="flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-bold"
                        style={{ background: t.bg, color: t.color }}
                      >
                        {t.icon}
                      </div>
                      <div className="text-[11px] font-bold text-foreground">{t.name}</div>
                      <div className="text-[9px] text-muted-foreground">{t.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 右：项目信息 */}
              <div className="dual-right px-[22px] py-3.5">
                <div className="section-label mb-2.5 text-[10px] font-bold tracking-[0.8px] uppercase text-muted-foreground">项目信息</div>
                <div className="flex flex-col">
                  <div className="info-row flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
                    <div className="info-icon-wrap flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]" style={STYLE_ICON_INDIGO}><Icon name="user" size={14} aria-hidden="true" /></div>
                    <span className="info-key shrink-0 text-xs font-medium text-muted-foreground" style={STYLE_INFO_KEY}>作者</span>
                    <span className="info-val ml-auto text-right"><span className="info-tag tag-purple inline-block rounded-md px-2 py-0.5 text-[11px] font-bold">lzlkyb</span></span>
                  </div>
                  <div className="info-row flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
                    <div className="info-icon-wrap flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]" style={STYLE_ICON_GREEN}><Icon name="file" size={14} aria-hidden="true" /></div>
                    <span className="info-key shrink-0 text-xs font-medium text-muted-foreground" style={STYLE_INFO_KEY}>开源协议</span>
                    <span className="info-val ml-auto text-right"><span className="info-tag tag-green inline-block rounded-md px-2 py-0.5 text-[11px] font-bold">MIT</span></span>
                  </div>
                  <div className="info-row flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
                    <div className="info-icon-wrap flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]" style={STYLE_ICON_ORANGE}><Icon name="package" size={14} aria-hidden="true" /></div>
                    <span className="info-key shrink-0 text-xs font-medium text-muted-foreground" style={STYLE_INFO_KEY}>仓库地址</span>
                    <span className="info-val ml-auto text-right">
                      <button
                        type="button"
                        onClick={openRepo}
                        className="info-tag info-tag-clickable tag-orange inline-block cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-bold transition-all hover:translate-y-[-1px] hover:shadow-sm"
                      >
                        GitHub ↗
                      </button>
                    </span>
                  </div>
                  <div className="info-row flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
                    <div className="info-icon-wrap flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]" style={STYLE_ICON_ACCENT}><Icon name="info" size={14} aria-hidden="true" /></div>
                    <span className="info-key shrink-0 text-xs font-medium text-muted-foreground" style={STYLE_INFO_KEY}>简介</span>
                    <span className="info-desc ml-auto truncate text-[11px] text-muted-foreground" style={{ maxWidth: 160 }}>
                      {APP_INFO.description}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
                      className="info-detail-btn flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border-0 p-0 transition-colors"
                      style={STYLE_ICON_ACCENT}
                      title="了解更多"
                    >
                      <Icon name="info" size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="about-divider h-px bg-border" />

            {/* 更新历史 — 分类标签行 */}
            <div className="px-[22px] py-3.5">
              <div className="section-label mb-2.5 text-[10px] font-bold tracking-[0.8px] uppercase text-muted-foreground">更新历史</div>

              {CHANGELOG.length > 0 && (
                <>
                  {/* 最新版本 — 完全展开 + 高亮 */}
                  <div className="cl-version-block mb-1.5">
                    <div className="cl-version-bar flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors" style={STYLE_CL_VERSION_BAR}>
                      <span className="cl-version-capsule shrink-0 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold text-white" style={STYLE_CL_CAPSULE}>v{CHANGELOG[0].version}</span>
                      <span className="cl-date shrink-0 text-[10px] text-muted-foreground" style={STYLE_CL_DATE}>{CHANGELOG[0].date}</span>
                      <span className="flex-1" />
                      <span className="cl-latest-tag shrink-0 rounded px-1.5 text-[8px] font-bold tracking-wider text-white" style={STYLE_CL_CAPSULE}>最新</span>
                    </div>
                    {CHANGELOG[0].items.map((item, j) => (
                      <div key={j} className="cl-item flex items-baseline gap-2 rounded-md px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground transition-colors hover:bg-muted" style={STYLE_CL_ITEM_PAD}>
                        <span className={`cl-badge shrink-0 rounded px-1.5 text-[9px] font-extrabold tracking-wider whitespace-nowrap ${CATEGORY_CLASS[item.category]}`}>{CATEGORY_LABELS[item.category]}</span>
                        {item.text}
                      </div>
                    ))}
                  </div>

                  {/* 折叠的历史版本 */}
                  {showMoreHistory && CHANGELOG.slice(1).map((entry) => (
                    <div key={entry.version} className="cl-version-block mb-1.5">
                      <div className="cl-version-bar flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted">
                        <span className="cl-version-capsule shrink-0 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold text-muted-foreground" style={STYLE_CL_CAPSULE_MUTED}>v{entry.version}</span>
                        <span className="cl-date shrink-0 text-[10px] text-muted-foreground" style={STYLE_CL_DATE}>{entry.date}</span>
                        <span className="flex-1" />
                      </div>
                      {entry.items.map((item, j) => (
                        <div key={j} className="cl-item flex items-baseline gap-2 rounded-md px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground transition-colors hover:bg-muted" style={STYLE_CL_ITEM_PAD}>
                          <span className={`cl-badge shrink-0 rounded px-1.5 text-[9px] font-extrabold tracking-wider whitespace-nowrap ${CATEGORY_CLASS[item.category]}`}>{CATEGORY_LABELS[item.category]}</span>
                          {item.text}
                        </div>
                      ))}
                    </div>
                  ))}

                  {/* 折叠按钮 */}
                  {CHANGELOG.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setShowMoreHistory(!showMoreHistory)}
                      className="changelog-toggle mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-transparent px-2 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:bg-muted hover:text-foreground"
                    >
                      <Icon name="chevronDown" size={12} className={`transition-transform duration-200 ${showMoreHistory ? "rotate-180" : ""}`} />
                      <span>{showMoreHistory ? "收起历史版本" : `查看更多版本 (${CHANGELOG.length - 1})`}</span>
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="about-footer flex items-center justify-between border-t border-border px-[22px] py-2.5">
              <span className="text-[10px] text-muted-foreground">© 2026 CC Bridge · MIT License · by {APP_INFO.author}</span>
            </div>
          </div>
        )}
      </Card>

      {/* ═══ 弹框：关于 CC Bridge ═══ */}
      {showModal && (
        <div
          className="modal-overlay fixed inset-0 z-[1000] flex items-center justify-center"
          style={STYLE_MODAL_OVERLAY}
          onClick={() => setShowModal(false)}
        >
          <div
            className="modal-box mx-4 max-h-[80vh] w-[480px] max-w-[90vw] overflow-y-auto rounded-2xl border border-border p-7 shadow-2xl"
            style={STYLE_MODAL_BOX}
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
                onClick={() => setShowModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            {/* 正文 */}
            <div className="modal-body text-[13px] leading-relaxed text-muted-foreground">
              <p className="mb-3.5">
                CC Bridge 是一款轻量级桌面应用，基于 <strong className="text-foreground">Tauri 2 + Rust</strong> 构建。
                它为 AI 编程助手提供标准的 MCP（Model Context Protocol）本地文件系统桥接服务，
                让 AI 能够安全地读写文件、搜索内容、执行命令。
              </p>

              <div className="section-label mb-2.5 text-[10px] font-bold tracking-[0.8px] uppercase text-muted-foreground">核心能力</div>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {HIGHLIGHTS.map((h) => (
                  <div key={h.label} className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2 text-xs font-semibold text-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: h.color }} />
                    {h.label}
                  </div>
                ))}
              </div>

              <div className="section-label mb-2.5 text-[10px] font-bold tracking-[0.8px] uppercase text-muted-foreground">特色优势</div>
              <p className="mb-2.5 text-xs leading-relaxed">
                · <strong className="text-foreground">极轻量：</strong>安装包仅 3.4MB，启动内存 &lt; 20MB<br/>
                · <strong className="text-foreground">全离线：</strong>无需网络，纯本地运行，数据不出设备<br/>
                · <strong className="text-foreground">安全沙箱：</strong>路径白名单 + 危险命令拦截 + Job Object 进程隔离<br/>
                · <strong className="text-foreground">标准协议：</strong>兼容 Cursor / Claude / VS Code 等 MCP 客户端<br/>
                · <strong className="text-foreground">MIT 开源：</strong>完全免费，代码透明可审计
              </p>

              <div className="modal-stats flex gap-5 border-t border-border pt-3">
                {STATS.map((s) => (
                  <div key={s.label} className="flex flex-1 flex-col items-center text-center">
                    <div className="text-lg font-extrabold text-foreground">{s.val}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── 更新状态胶囊 ── */
function UpdateStatusPill({ status, update }: { status: UpdateStatus; update: { version: string } | null }) {
  if (status === "uptodate") {
    return (
      <span className="status-pill flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-[3px] text-[11px] font-semibold text-success">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        已是最新
      </span>
    );
  }
  if (status === "available") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-[3px] text-[11px] font-semibold text-warning">
        有新版本 v{update?.version}
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-[3px] text-[11px] font-semibold text-success">
        已下载
      </span>
    );
  }
  return null;
}

/* ── 更新操作按钮 ── */
function UpdateActionBtn({
  status,
  onCheck,
  onDownload,
  onRestart,
}: {
  status: UpdateStatus;
  onCheck: () => void;
  onDownload: () => void;
  onRestart: () => void;
}) {
  if (status === "checking") {
    return (
      <Button size="sm" disabled>
        <Icon name="spinner" size={13} className="animate-spin" />
        检查中…
      </Button>
    );
  }
  if (status === "available") {
    return (
      <Button size="sm" onClick={onDownload}>
        <Icon name="download" size={13} />
        下载安装
      </Button>
    );
  }
  if (status === "downloading") {
    return (
      <Button size="sm" disabled>
        <Icon name="download" size={13} />
        下载安装
      </Button>
    );
  }
  if (status === "ready") {
    return <Button size="sm" onClick={onRestart}>重启更新</Button>;
  }
  if (status === "error") {
    return (
      <Button size="sm" variant="outline" onClick={onCheck}>
        重试
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" onClick={onCheck}>
      检查更新
    </Button>
  );
}
