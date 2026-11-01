import { useId, useMemo, useState, type ReactNode } from "react";
import { AVAILABLE_PRESENTATION, type UpdatePresentation } from "../../lib/updatePresentation";
import { countReleaseItems, createUpdateNotesModel, type ReleaseContent, type UpdateNotesInfo } from "../../lib/updateNotes";
import { Icon } from "../ui/icon";
import { UpdateBrand } from "./UpdateBrand";
import { UpdateActions, UpdateProcess } from "./UpdateProcess";
import "./update-dialog.css";

function formattedDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function textContent(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
  );
}

function ReleaseDetails({ content }: { content: ReleaseContent }) {
  return <div className="update-release-notes">
    {content.summary.map((text, index) => <p key={`summary-${index}`}>{textContent(text)}</p>)}
    {content.paragraphs.map((text, index) => <p key={`paragraph-${index}`}>{textContent(text)}</p>)}
    {content.groups.map(group => <section key={group.label}>
      <h4>{group.label}<span>{group.items.length}</span></h4>
      <ul>{group.items.map((text, index) => <li key={index}>{textContent(text)}</li>)}</ul>
    </section>)}
    {content.highlights.map((text, index) => <p key={`highlight-${index}`}>{textContent(text)}</p>)}
  </div>;
}

function Disclosure({ label, children, secondary = false }: { label: string; children: ReactNode; secondary?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className={`update-disclosure${secondary ? " update-disclosure-history" : ""}`}>
    <button type="button" className="interactive update-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>{label}</span><Icon name="chevronDown" size={14} aria-hidden="true" />
    </button>
    {/* Long histories mount only when requested; no per-row animation or continuous work. */}
    <div id={id} hidden={!open} className="update-disclosure-body">{open ? children : null}</div>
  </section>;
}

export function UpdateDialogContent({ update, process = AVAILABLE_PRESENTATION, onClose, onDownload, onDismiss, onRestart, onRetry, onRefreshSafety }: {
  update: UpdateNotesInfo;
  process?: UpdatePresentation;
  onClose: () => void;
  onDownload: () => void;
  onDismiss: () => void;
  onRestart?: () => void;
  onRetry?: () => void;
  onRefreshSafety?: () => void;
}) {
  const model = useMemo(() => createUpdateNotesModel(update), [update]);
  const { latest, releases, highlights, total, counts } = model;
  const cross = releases.length > 1;
  const date = formattedDate(latest.date);
  const hasNotes = latest.groups.length || latest.summary.length || latest.paragraphs.length || latest.highlights.length;
  return <>
    <button type="button" onClick={onClose} className="interactive update-close" aria-label="关闭更新弹窗"><Icon name="close" size={17} aria-hidden="true" /></button>
    <UpdateBrand currentVersion={update.currentVersion} version={latest.version} ready={process.status === "ready"} />
    <div className="update-dialog-main">
    <header className="update-dialog-header">
      <h2>{process.status === "ready" ? "新的体验，已准备好" : process.status === "downloading" ? "让好体验，即刻就绪" : process.status === "error" ? "再试一次，继续升级" : "发现新版本"}</h2>
      <p>{date ? `${date}发布 · ` : ""}每一次更新，都是更顺手的一步。</p>
    </header>
    <div className="update-dialog-scroll" tabIndex={0} role="region" aria-label="更新内容">
      <UpdateProcess process={process} />
      <section className="update-upgrade" aria-label="升级版本与更新范围">
        <p>{cross ? `从你当前的版本起，汇总已收录的 ${releases.length} 个版本更新。` : "新的更新已准备就绪，以下是本次发布的更新内容。"}</p>
        {total > 0 && <div className="update-stats"><span><strong>{total}</strong>条更新记录</span>{Object.entries(counts).map(([label, count]) => <span key={label}><strong>{count}</strong>{label}</span>)}</div>}
      </section>
      {highlights.length > 0 && <section aria-label="升级亮点" className="update-benefits-section">
        <div className="update-benefits-heading"><h3>{cross ? "这次升级，值得期待的变化" : "本次更新亮点"}</h3><span>精选 {Math.min(3, highlights.length)} 项变化</span></div>
        <ul className="update-benefits">{highlights.slice(0, 3).map(({ version, text }) => {
          const plain = text.replace(/\*\*/g, "");
          const split = plain.search(/：|:\s/);
          const title = split < 0 ? plain : plain.slice(0, split);
          const description = split < 0 ? "" : plain.slice(split + 1).trim();
          return <li key={`${version}-${text}`}>
            <div className="update-benefit-title"><Icon name="sparkles" size={16} aria-hidden="true" /><h4>{title}</h4></div>
            {description && <p>{description}</p>}
            <span className="update-source-version">来自 <strong>v{version.replace(/^v/, "")}</strong></span>
          </li>;
        })}</ul>
      </section>}
      {hasNotes ? <Disclosure label={`本次发布${latest.version ? ` · v${latest.version}` : ""}${countReleaseItems(latest) ? ` · ${countReleaseItems(latest)} 条记录` : " · 更新说明"}`}>
        <ReleaseDetails content={latest} />
      </Disclosure> : <p className="update-empty">此版本未提供详细说明。</p>}
      {cross && <Disclosure secondary label={`查看跨版本完整记录${total ? ` · ${total} 条` : ""}`}>
        {releases.map(release => <article className="update-history-release" key={release.version}>
          <h3>v{release.version}<time>{formattedDate(release.date)}</time></h3>
          <ReleaseDetails content={release} />
        </article>)}
      </Disclosure>}
    </div>
    <UpdateActions process={process} onClose={onClose} onDownload={onDownload} onDismiss={onDismiss} onRestart={onRestart} onRetry={onRetry} onRefreshSafety={onRefreshSafety} />
    </div>
  </>;
}
