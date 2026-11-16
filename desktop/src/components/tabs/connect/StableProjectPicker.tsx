import { useId, useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import type { StableConnectState } from "../../../hooks/useStableConnect";
import { useStableFolders } from "../../../hooks/useStableFolders";
import { stableProjectName, type StableDiscovery, type StableProject } from "../../../lib/stableAccess";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { StableLogin } from "./StableLogin";

/** A dedicated folder chooser has no file upload, delete, or other file-browser actions. */
export function StableProjectPicker({ state, status, discovery, onChoose, onClose }: {
  state: StableConnectState; status?: StaticStatus; discovery?: StableDiscovery;
  onChoose: (project: StableProject) => void; onClose: () => void;
}) {
  const id = useId();
  const [view, setView] = useState<"recent" | "folders">("recent");
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState(() => discovery?.projects[0]?.path.split("/").slice(0, -1).join("/") || discovery?.home || "~");
  const [manual, setManual] = useState({ path: "", error: "" });
  const listing = useStableFolders(state, status, folder, view === "folders", discovery?.signature);
  const path = listing.data?.path ?? folder;
  const parts = path.startsWith("/") ? path.split("/").filter(Boolean) : [];
  const projects = (discovery?.projects ?? []).filter(project => `${project.name} ${project.path}`.toLowerCase().includes(search.toLowerCase()));
  const existing = (path: string) => discovery?.targets.some(target => target.projectPath === path);
  return <section className="sc-picker" aria-label="选择服务器项目">
    <div className="sc-picker-heading"><div><h3>选择服务器上的项目</h3><p>就是你在服务器上写代码的文件夹。</p></div><button type="button" className="stable-link sc-muted-link" aria-label="关闭项目选择" onClick={onClose}><Icon name="close" size={16}/></button></div>
    <div className="sc-picker-tabs" role="group" aria-label="项目查找方式"><button type="button" aria-pressed={view === "recent"} onClick={() => setView("recent")}>最近使用</button><button type="button" aria-pressed={view === "folders"} onClick={() => setView("folders")}><Icon name="folder" size={14}/>浏览服务器文件夹</button></div>
    {view === "recent" ? <>
      <div className="sc-search"><Icon name="search" size={15}/><input autoFocus aria-label="搜索项目" placeholder="搜索项目名称或文件夹" value={search} onChange={event => setSearch(event.target.value)}/></div>
      <div className="sc-project-list">{projects.map(project => <button type="button" key={project.path} className="sc-project-row" onClick={() => onChoose(project)}><Icon name="folder" size={18}/><span><b>{project.name}</b><small>{project.path}</small></span>{existing(project.path) && <span className="sc-project-meta"><em>已接入桥</em></span>}<Icon name="chevronRight" size={15}/></button>)}{!projects.length && <p className="sc-empty">{search ? "没有找到这个项目，可以浏览服务器文件夹。" : "还没有最近项目记录，可以浏览服务器文件夹。"}</p>}</div>
    </> : <>
      <nav className="sc-breadcrumb" aria-label="服务器文件夹路径"><button type="button" aria-label="返回上级文件夹" disabled={path === "/" || listing.loading} onClick={() => setFolder(listing.data?.parent || "/")}><Icon name="arrowUp" size={15}/></button><button type="button" onClick={() => setFolder("/")}>根目录</button>{parts.map((part, index) => <span key={index}><Icon name="chevronRight" size={12}/><button type="button" onClick={() => setFolder(`/${parts.slice(0, index + 1).join("/")}`)}>{part}</button></span>)}{!parts.length && path !== "/" && <span>{path}</span>}</nav>
      {listing.loading ? <p className="sc-empty" role="status"><Icon name="spinner" size={14} className="animate-spin"/>正在读取服务器文件夹…</p> : listing.error ? <div className="sc-folder-error" role="alert"><p>{listing.error}</p>{listing.needsSecret ? <StableLogin state={state} onSubmit={listing.retry} busy={listing.loading}/> : <button type="button" className="stable-link" onClick={listing.retry}>重新读取文件夹</button>}</div> : <div className="sc-folder-list">{listing.data?.directories.map(directory => <button type="button" key={directory.path} className="sc-project-row" aria-label={`打开 ${directory.name} 文件夹`} onClick={() => setFolder(directory.path)}><Icon name="folder" size={18}/><span><b>{directory.name}</b></span>{existing(directory.path) && <em className="sc-project-tag">已接入桥</em>}<Icon name="chevronRight" size={15}/></button>)}{!listing.data?.directories.length && <p className="sc-empty">这里没有下一级文件夹。</p>}</div>}
      {listing.data?.truncated && <p className="sc-picker-note">这个文件夹内容较多，先显示部分文件夹；也可以手动输入完整路径。</p>}
      <div className="sc-folder-footer"><p>已定位到 <code>{path}</code></p><Button size="sm" disabled={!listing.data || listing.loading} onClick={() => onChoose({ name: stableProjectName(path), path })}><Icon name="check" size={14}/>选用此文件夹</Button></div>
    </>}
    <details className="sc-manual"><summary>手动输入路径</summary><form onSubmit={event => {
      event.preventDefault(); const path = manual.path.trim();
      if (!path.startsWith("/") && path !== "~" && !path.startsWith("~/") || path.length > 4096 || /[\r\n\0]/.test(path)) {
        setManual(old => ({ ...old, error: "请填写服务器上的完整路径，例如 /home/ubuntu/projects/orders。" })); return;
      }
      onChoose({ name: stableProjectName(path), path });
    }}><label htmlFor={id}>远程项目路径</label><div><input id={id} value={manual.path} onChange={event => setManual({ path: event.target.value, error: "" })} placeholder="/home/ubuntu/projects/orders" aria-invalid={!!manual.error} aria-describedby={manual.error ? `${id}-error` : undefined}/><Button variant="outline" size="sm" type="submit">使用此目录</Button></div>{manual.error && <p id={`${id}-error`} role="alert">{manual.error}</p>}</form></details>
  </section>;
}
