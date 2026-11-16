import { useState } from "react";
import { Icon } from "../../components/ui/icon";
import { Button } from "../../components/ui/button";
import { folderChildren, projectFromPath, type BridgeEntry, type Project } from "./discovery";

export function ProjectPicker({ projects, entries, currentPath, onChoose, onClose }: {
  projects: Project[]; entries: BridgeEntry[]; currentPath: string | null;
  onChoose: (project: Project) => void; onClose: () => void;
}) {
  const [view, setView] = useState<"recent" | "folders">("recent");
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState(projects[0].path.split("/").slice(0, -1).join("/") || "/");
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const existing = (path: string) => entries.some(e => e.projectPath === path);
  const selectPath = (path: string) => onChoose(projectFromPath(path, projects));
  const parts = folder.split("/").filter(Boolean);
  const rows = projects.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(search.toLowerCase()));
  const folders = folderChildren(folder, projects);
  return <section className="sc-picker" aria-label="选择服务器项目">
    <div className="sc-picker-heading"><div><h3>选择服务器上的项目</h3><p>就是你在服务器上写代码的文件夹。</p></div><button type="button" className="qc-link sc-muted-link" aria-label="关闭项目选择" onClick={onClose}><Icon name="close" size={16}/></button></div>
    <div className="sc-picker-tabs" role="group" aria-label="项目查找方式"><button aria-pressed={view === "recent"} onClick={() => setView("recent")}>最近使用</button><button aria-pressed={view === "folders"} onClick={() => setView("folders")}><Icon name="folder" size={14}/>浏览服务器文件夹</button></div>
    {view === "recent" ? <>
      <div className="sc-search"><Icon name="search" size={15}/><input autoFocus aria-label="搜索项目" placeholder="搜索项目名称或文件夹" value={search} onChange={e => setSearch(e.target.value)}/></div>
      <div className="sc-project-list">{rows.map(project => <button type="button" key={project.path} className="sc-project-row" onClick={() => onChoose(project)}><Icon name="folder" size={18}/><span><b>{project.name}</b><small>{project.path}</small></span><span className="sc-project-meta">{existing(project.path) ? <em>已接入桥</em> : project.recent}</span><Icon name="chevronRight" size={15}/></button>)}{!rows.length && <p className="sc-empty">没有找到这个项目，可以浏览服务器文件夹。</p>}</div>
      {currentPath && <button type="button" className="sc-current-directory" onClick={() => selectPath(currentPath)}><Icon name="terminal" size={17}/><span><b>使用当前目录</b><small>服务器终端 · {currentPath}</small></span><Icon name="arrowRight" size={15}/></button>}
    </> : <>
      <nav className="sc-breadcrumb" aria-label="服务器文件夹路径"><button aria-label="返回上级文件夹" disabled={folder === "/"} onClick={() => setFolder(parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/")}><Icon name="arrowUp" size={15}/></button><button onClick={() => setFolder("/")}>根目录</button>{parts.map((part, index) => <span key={index}><Icon name="chevronRight" size={12}/><button onClick={() => setFolder(`/${parts.slice(0, index + 1).join("/")}`)}>{part}</button></span>)}</nav>
      <div className="sc-folder-list">{folders.map(name => {
        const path = `${folder === "/" ? "" : folder}/${name}`;
        const project = projects.find(p => p.path === path);
        return <button type="button" key={name} className="sc-project-row" aria-label={`打开 ${name} 文件夹`} onClick={() => setFolder(path)}><Icon name="folder" size={18}/><span><b>{name}</b>{project && <small>{project.name}</small>}</span>{existing(path) && <em className="sc-project-tag">已接入桥</em>}<Icon name="chevronRight" size={15}/></button>;
      })}{!folders.length && <p className="sc-empty">这里没有下一级文件夹。</p>}</div>
      <div className="sc-folder-footer"><p>已定位到 <code>{folder}</code></p><Button size="sm" onClick={() => selectPath(folder)}><Icon name="check" size={14}/>选用此文件夹</Button></div>
    </>}
    <details className="sc-manual"><summary>手动输入路径</summary><form onSubmit={e => { e.preventDefault(); const path = manual.trim().replace(/\/+$/, "") || "/"; if (!manual.trim().startsWith("/") || /[\r\n\0]/.test(manual)) { setError("请填写服务器上的完整路径，例如 /home/ubuntu/projects/orders。"); return; } selectPath(path); }}><label htmlFor="sc-manual-path">远程项目路径</label><div><input id="sc-manual-path" value={manual} onChange={e => { setManual(e.target.value); setError(""); }} placeholder="/home/ubuntu/projects/orders" aria-invalid={!!error} aria-describedby={error ? "sc-path-error" : undefined}/><Button variant="outline" size="sm" type="submit">使用此目录</Button></div>{error && <p id="sc-path-error" role="alert">{error}</p>}</form></details>
  </section>;
}
