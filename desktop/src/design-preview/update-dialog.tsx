import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CHANGELOG } from "../lib/about";
import { UpdateNotesDialog } from "../components/update/UpdateNotesDialog";
import type { UpdateNotesInfo } from "../lib/updateNotes";
import { AVAILABLE_PRESENTATION, type UpdatePresentation } from "../lib/updatePresentation";
import "../index.css";
import "../appearance.css";
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
  long: { version: "123.456.789-beta.123", currentVersion: "2.9.1", body: "长版本号兼容检查。" },
  plain: { version: "99.0.0", currentVersion: "2.9.1", body: "这是一条旧更新源提供的纯文字说明。\n第二行内容同样保留。" },
};

/** Dev-only real component harness: no UpdateProvider, IPC, installation, or persisted settings. */
function UpdatePreview() {
  const [scenario, setScenario] = useState("cross");
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("open"));
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  const [process, setProcess] = useState<UpdatePresentation>(AVAILABLE_PRESENTATION);
  const [glass, setGlass] = useState(true);
  document.documentElement.dataset.uiStyle = glass ? "glass" : "classic";
  return <main className="min-h-screen bg-background p-7 text-foreground">
    <h1 className="mb-2 text-lg font-semibold">更新弹窗 · 正式组件验收</h1>
    <p className="mb-6 text-sm text-muted-foreground">真实已发布记录演示，操作不会下载或修改软件设置。</p>
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="更新场景" className="rounded-lg border border-border bg-card p-2" value={scenario} onChange={event => setScenario(event.target.value)}>
        <option value="cross">跨版本更新</option><option value="normal">单版本更新</option><option value="unknown">当前版本未知</option><option value="empty">没有更新说明</option><option value="plain">旧格式纯文字说明</option><option value="long">长版本号</option>
      </select>
      <button className="rounded-lg border border-border p-2" onClick={() => { document.documentElement.classList.toggle("dark", !dark); setDark(!dark); }}>{dark ? "切换浅色" : "切换深色"}</button>
      <select aria-label="更新阶段" className="rounded-lg border border-border bg-card p-2" onChange={event => {
        const status = event.target.value;
        setProcess({ ...AVAILABLE_PRESENTATION, status: status === "busy" || status === "unknown" ? "ready" : status as UpdatePresentation["status"], progress: 42, indeterminate: false, downloadedBytes: 42 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, bytesPerSec: 2.4 * 1024 * 1024, error: status === "error" ? "无法连接更新服务器，请检查网络或代理设置" : null,
          safety: status === "unknown" ? { state: "unknown" } : { state: "known", activity: { conversations: status === "busy" ? 1 : 0, agents: status === "busy" ? 2 : 0, commands: 0, transfers: 0 } } });
      }}><option value="available">发现新版本</option><option value="downloading">下载中</option><option value="ready">待重启</option><option value="busy">任务运行中</option><option value="unknown">任务状态未知</option><option value="error">下载失败</option></select>
      <button className="rounded-lg border border-border p-2" onClick={() => setGlass(!glass)}>{glass ? "切换经典" : "切换毛玻璃"}</button>
      <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" onClick={() => { setMessage(""); setOpen(true); }}>打开更新弹窗</button>
    </div>
    <p role="status" className="mt-5 text-sm text-muted-foreground">{message}</p>
    <UpdateNotesDialog open={open} update={scenarios[scenario]} process={process}
      onClose={() => setOpen(false)} onDismiss={() => setMessage("已模拟忽略此版本。")}
      onDownload={() => setProcess({ ...process, status: "downloading", indeterminate: true })}
      onRestart={() => setMessage("验收预览：已模拟确认重启，不执行真实安装。")}
      onRetry={() => setProcess(AVAILABLE_PRESENTATION)}
      onRefreshSafety={() => setProcess({ ...process, safety: { state: "known", activity: { conversations: 0, agents: 0, commands: 0, transfers: 0 } } })} />
  </main>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><UpdatePreview /></StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
