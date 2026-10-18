import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CHANGELOG } from "../lib/about";
import { UpdateNotesDialog } from "../components/update/UpdateNotesDialog";
import type { UpdateNotesInfo } from "../lib/updateNotes";
import "../index.css";
import "../interaction-refinements.css";

const labels = { feat: "新增", improve: "变更", fix: "修复", sec: "安全" };
const records = CHANGELOG.map(release => ({
  version: release.version, date: release.date,
  body: (release.highlights?.length ? "### 亮点\n" + release.highlights.map(text => "- " + text).join("\n") + "\n" : "") +
    Object.entries(labels).map(([category, label]) => "### " + label + "\n" + release.items.filter(item => item.category === category).map(item => "- " + item.text).join("\n")).join("\n"),
}));
const body = records[0].body + "\n\n<!-- cc-bridge-release-history:" + JSON.stringify(records) + " -->";
const scenarios: Record<string, UpdateNotesInfo> = {
  cross: { version: "2.9.1", currentVersion: "2.7.7", date: records[0].date, body },
  normal: { version: "2.9.1", currentVersion: "2.9.0", date: records[0].date, body },
  unknown: { version: "2.9.1", date: records[0].date, body },
  empty: { version: "99.0.0", currentVersion: "2.9.1", body: null },
  plain: { version: "99.0.0", currentVersion: "2.9.1", body: "这是一条旧更新源提供的纯文字说明。\n第二行内容同样保留。" },
};

/** Dev-only real component harness: no UpdateProvider, IPC, installation, or persisted settings. */
function UpdatePreview() {
  const [scenario, setScenario] = useState("cross");
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  return <main className="min-h-screen bg-background p-7 text-foreground">
    <h1 className="mb-2 text-lg font-semibold">更新弹窗 · 正式组件验收</h1>
    <p className="mb-6 text-sm text-muted-foreground">真实已发布记录演示，操作不会下载或修改软件设置。</p>
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="更新场景" className="rounded-lg border border-border bg-card p-2" value={scenario} onChange={event => setScenario(event.target.value)}>
        <option value="cross">跨版本更新</option><option value="normal">单版本更新</option><option value="unknown">当前版本未知</option><option value="empty">没有更新说明</option><option value="plain">旧格式纯文字说明</option>
      </select>
      <button className="rounded-lg border border-border p-2" onClick={() => { document.documentElement.classList.toggle("dark", !dark); setDark(!dark); }}>{dark ? "切换浅色" : "切换深色"}</button>
      <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" onClick={() => { setMessage(""); setOpen(true); }}>打开更新弹窗</button>
    </div>
    <p role="status" className="mt-5 text-sm text-muted-foreground">{message}</p>
    <UpdateNotesDialog open={open} update={scenarios[scenario]} onClose={() => setOpen(false)} onDismiss={() => setMessage("已模拟稍后，不再主动提示此版本。")} onDownload={() => setMessage("已模拟下载，正式软件沿用侧栏更新进度。")} />
  </main>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><UpdatePreview /></StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
