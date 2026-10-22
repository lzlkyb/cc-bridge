import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { normalizeRemoteDir, remoteDirError } from "../../lib/uploadDir";
import "../../file-navigation.css";

interface Props {
  path: string; disabled: boolean; loading: boolean;
  onNavigate: (path: string) => void; onUp: () => void;
  canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void;
}

/** Breadcrumbs and explicit path entry share the same navigation and loading guard. */
export function FilePathBar({ path, disabled, loading, onNavigate, onUp, canBack, canForward, onBack, onForward }: Props) {
  const [draft, setDraft] = useState({ editing: false, value: path, error: "" });
  const input = useRef<HTMLInputElement>(null), edit = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => { setDraft({ editing: false, value: path, error: "" }); }, [path]);
  useEffect(() => { if (draft.editing) { input.current?.focus(); input.current?.select(); } else if (restoreFocus.current && !disabled) { edit.current?.focus(); restoreFocus.current = false; } }, [draft.editing, disabled]);
  const cancel = () => { restoreFocus.current = true; setDraft({ editing: false, value: path, error: "" }); };
  const parts = path.split("/").filter(Boolean);
  return <div className="file-path-bar">
    <div className="file-path-controls">
      <button type="button" className="file-nav-icon" disabled={disabled || !canBack} aria-label="后退到上一目录" title="后退" onClick={onBack}><Icon name="arrowLeft" size={16}/></button>
      <button type="button" className="file-nav-icon" disabled={disabled || !canForward} aria-label="前进到下一目录" title="前进" onClick={onForward}><Icon name="arrowLeft" size={16} className="rotate-180"/></button>
      <button type="button" className="file-nav-up" disabled={disabled || path === "/"} onClick={onUp}>上一级</button>
    </div>
    {draft.editing ? <form className="file-path-form" onSubmit={event => {
      event.preventDefault(); if (disabled) return;
      const error = remoteDirError(draft.value);
      if (error) { setDraft(old => ({ ...old, error })); input.current?.focus(); return; }
      onNavigate(normalizeRemoteDir(draft.value)); cancel();
    }}>
      <input ref={input} aria-label="远程目录路径" aria-invalid={!!draft.error} aria-describedby={draft.error ? "file-path-error" : undefined} disabled={disabled} value={draft.value} onChange={event => setDraft(old => ({ ...old, value: event.target.value, error: "" }))} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}/>
      <button type="submit" disabled={disabled}>前往</button><button type="button" onClick={cancel}>取消</button>
      {draft.error && <p id="file-path-error" role="alert">{draft.error}</p>}
    </form> : <>
      <nav className="file-path-crumbs" aria-label="远程目录路径">
        <button type="button" disabled={disabled || path === "/"} aria-current={path === "/" ? "page" : undefined} onClick={() => onNavigate("/")}>根目录</button>
        {parts.map((part, i) => <span key={i}><span aria-hidden="true">/</span>{i === parts.length - 1 ? <span aria-current="page" title={path}>{part}</span> : <button type="button" disabled={disabled} title={"/" + parts.slice(0, i + 1).join("/")} onClick={() => onNavigate("/" + parts.slice(0, i + 1).join("/"))}>{part}</button>}</span>)}
      </nav>
      <button ref={edit} type="button" className="file-path-edit" disabled={disabled} onClick={() => setDraft({ editing: true, value: path, error: "" })}>编辑路径</button>
    </>}
    {loading && <span className="file-path-loading" role="status">加载中…</span>}
  </div>;
}
