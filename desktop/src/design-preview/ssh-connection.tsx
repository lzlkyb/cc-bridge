import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SshConnectionDialog } from "../components/tabs/SshConnectionDialog";
import { TerminalSidebar } from "../components/tabs/TerminalSidebar";
import { useSshSessions } from "../components/tabs/useSshSessions";
import { ToastProvider, toast } from "../components/ui/toast";
import { emptySshConnection } from "../lib/sshConnectionForm";
import type { SshConnection } from "../lib/types";
import "../index.css";
import "../appearance.css";
import "../interaction-refinements.css";
import "../terminal-workspace.css";

// The harness is an independent dev entry. No real credentials, SSH process or network calls.
let savedConnections: SshConnection[] = [
  { ...emptySshConnection(), id: "company", name: "公司开发服务器", host: "10.0.19.194", username: "lizuliang", rememberPassword: true, encryptedPassword: "preview-only-ciphertext" },
  { ...emptySshConnection(), id: "staging", name: "预发布环境", host: "192.168.1.20", username: "ubuntu", authType: "key", keyPath: "C:/keys/id_ed25519", rememberPassphrase: true, encryptedPassphrase: "preview-only-ciphertext" },
  { ...emptySshConnection(), id: "jump", name: "办公跳板机", host: "bastion.example.com", port: 2222, username: "deploy" },
];
let fail = false, sequence = 0;
if (import.meta.env.DEV) Object.assign(window, { __TAURI_INTERNALS__: {
  invoke: async (cmd: string, payload: { args?: { connection: SshConnection }; id?: string }) => {
    if (cmd === "ssh_connect") { await new Promise(r => setTimeout(r, 900)); if (fail) throw new Error("连接超时，请检查主机、端口或跳板机配置"); return `preview-${++sequence}`; }
    if (cmd === "ssh_save_connection") {
      const connection = { ...payload.args!.connection, id: payload.args!.connection.id || `connection-${++sequence}` };
      savedConnections = [...savedConnections.filter(c => c.id !== connection.id), connection]; return connection;
    }
    if (cmd === "ssh_reveal_credential") return "preview-only";
    if (cmd === "plugin:dialog|open") return "C:/Users/demo/.ssh/id_ed25519";
    if (cmd === "ssh_disconnect") return;
    throw new Error("预览不支持此操作");
  },
} });

function Preview() {
  const [connections, setConnections] = useState(savedConnections);
  const [open, setOpen] = useState(new URLSearchParams(location.search).has("open"));
  const [editing, setEditing] = useState<SshConnection | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [glass, setGlass] = useState(true);
  const ssh = useSshSessions();
  const active = ssh.sessions.find(s => s.sessionId === ssh.activeId);
  const create = () => { setEditing(null); setOpen(true); };
  document.documentElement.dataset.uiStyle = glass ? "glass" : "classic";
  return <div className="h-screen flex flex-col bg-background text-foreground">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 text-xs">
      <span><b>SSH 工作区 · 正式组件验收</b> <span className="text-muted-foreground">模拟连接，不访问服务器</span></span>
      <div className="flex gap-3"><select aria-label="连接结果" onChange={e => { fail = e.target.value === "failure"; }}><option value="success">连接成功</option><option value="failure">连接失败</option></select>
        <button onClick={() => { document.documentElement.classList.toggle("dark", !dark); setDark(!dark); }}>{dark ? "切换浅色" : "切换深色"}</button><button onClick={() => setGlass(!glass)}>{glass ? "经典实色" : "毛玻璃"}</button>
      </div>
    </header>
    <div className="flex flex-1 min-h-0 p-3 gap-3" style={{ background: glass ? "radial-gradient(ellipse at left top,hsl(var(--primary)/.12),transparent 65%)" : undefined }}>
      <aside style={{ width: 300 }} className="flex flex-col shrink-0 rounded-xl bg-card/50 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4"><img src="/icon.png" width="30" height="30" alt=""/><b>CC Bridge</b></div>
        <TerminalSidebar embedded connections={connections} sessions={ssh.sessions} activeId={ssh.activeId} isLoading={false} collapsed={false} connectingId={ssh.connectingId} connectingIds={ssh.connectingIds} connectionErrors={ssh.connectionErrors} confirmingDelete={deleting} onSetCollapsed={() => {}} onNew={create} onConnect={c => void ssh.connect(c)} onDisconnect={id => void ssh.disconnect(id)} onNewTerminal={c => void ssh.connect(c, { newTab: true })} onActivate={ssh.setActiveId} onOpenFiles={() => toast("此预览聚焦连接设置；文件面板沿用现有功能", "info")} onEdit={c => { setEditing(c); setOpen(true); }} onDeleteRequest={setDeleting} onConfirmDelete={id => { savedConnections = connections.filter(c => c.id !== id); setConnections(savedConnections); ssh.dropConnection(id); setDeleting(null); }} onCancelDelete={() => setDeleting(null)}/>
      </aside>
      <main className="flex flex-col flex-1 min-w-0 overflow-hidden rounded-2xl bg-[#202228] text-[#d6d9e4]">
        <div className="flex flex-wrap gap-2 bg-card p-3 text-foreground">{ssh.sessions.map(s => <button key={s.tabId} className={`rounded-lg px-3 py-2 text-xs ${s.sessionId === ssh.activeId ? "bg-primary/10 text-primary" : ""}`} onClick={() => ssh.setActiveId(s.sessionId)}>{s.conn.name} {s.label || "终端"}{s.closedReason ? " · 已断开" : ""}</button>)}<button className="rounded-lg px-3 py-2 text-xs" onClick={create}>＋ 新建连接</button></div>
        <div className="p-7 font-mono text-sm leading-8 overflow-auto">{active ? <><p className="text-[#9ba3b6]">SSH session · {active.conn.host}</p><p>Welcome to Ubuntu 24.04.1 LTS</p><br/><p className="text-[#85cfaf]">{active.closedReason || "Connection established. Your workspace is ready."}</p><p>{active.conn.username}@server:~$ <span className="text-[#9ba3b6]">此处为终端占位，连接设置使用正式组件。</span></p></> : <><h1 className="text-lg mb-2">连接到你的服务器</h1><p className="text-[#9ba3b6]">选择左侧服务器，或新建一个 SSH 连接。</p></>}</div>
      </main>
    </div>
    <SshConnectionDialog open={open} initial={editing} connections={connections} onClose={() => setOpen(false)} onSaved={() => setConnections([...savedConnections])} onConnect={(c, credentials) => void ssh.connect(c, { newTab: true, credentials })}/>
  </div>;
}
if (import.meta.env.DEV) {
  const root = createRoot(document.getElementById("root")!); root.render(<ToastProvider><Preview/></ToastProvider>);
  if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
}
