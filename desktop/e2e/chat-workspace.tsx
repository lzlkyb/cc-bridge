// Isolated test fixture: production components and hooks, deterministic IPC; never imports into the app entry.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { CcEvent } from "../src/lib/ccEventTypes";
import "../src/index.css";
import "../src/appearance.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") || "normal";
document.documentElement.dataset.uiStyle = params.get("material") || "glass";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
localStorage.setItem("cc-bridge.ccgui.cwd.local", "D:/projects/web-console");
localStorage.setItem("cc-bridge.ccgui.model", "opus");
const finish: CcEvent = { kind: "turnEnd", sessionId: "review-session", isError: false, text: null, usage: { input_tokens: 1300, output_tokens: 220 }, modelUsage: { opus: { inputTokens: 28000, outputTokens: 220, contextWindow: 200000 } }, costUsd: .21, numTurns: 1, durationMs: 16000 };
const initial: CcEvent[] = [
  { kind: "init", sessionId: "review-session", cwd: "D:/projects/web-console", model: "opus" },
  { kind: "userMessage", text: "帮我梳理项目的登录流程，找一下可能导致登录超时的原因。" },
  ...["src/api/client.ts", "src/pages/login.tsx", "src/hooks/useAuth.ts"].flatMap((path, index): CcEvent[] => [
    { kind: "toolUse", toolUseId: `read-${index}`, name: "Read", input: { file_path: path } },
    { kind: "toolResult", toolUseId: `read-${index}`, content: `已读取 ${path}`, isError: false, durationMs: 200 },
  ]),
  { kind: "text", blockId: "answer-1", streaming: false, text: "**定位到了：超时主要发生在请求重试环节。**\n\n登录入口本身没有阻塞。网络不稳定时，自动重试会把等待时间叠加，界面又没有及时结束加载状态。\n\n### 建议先处理这两处\n\n- **收紧重试范围。** 登录请求超时后直接提示重试，避免重复提交。\n- **补齐失败反馈。** 区分网络超时与账号验证失败，保留已填写内容。\n\n我可以先补上超时处理与测试，再一起检查错误提示。" }, finish,
];
if (scene === "approval") initial.push({ kind: "permissionAsk", requestId: "approval-1", toolUseId: "edit-1", toolName: "Edit", input: { file_path: "src/api/client.ts", old_string: "retry: 3", new_string: "retry: 0" }, reason: "修改超时重试前，请确认改动范围。" });
if (scene === "results") initial.push(
  { kind: "userMessage", text: "修复并运行检查" },
  { kind: "toolUse", toolUseId: "edit-result", name: "Edit", input: { file_path: "src/api/client.ts", old_string: "retry: 3", new_string: "retry: 0" } },
  { kind: "toolResult", toolUseId: "edit-result", content: "修改完成", isError: false },
  { kind: "toolUse", toolUseId: "cmd-result", name: "Bash", input: { command: "npm run test" } },
  { kind: "toolResult", toolUseId: "cmd-result", content: "命令结束", isError: false },
  { kind: "text", blockId: "answer-results", streaming: false, text: "已完成修改和检查。" }, finish,
);
if (scene === "long") for (let index = 0; index < 250; index++) initial.push({ kind: "userMessage", text: `历史问题 ${index + 1}` }, { kind: "text", blockId: `long-${index}`, streaming: false, text: `这是第 ${index + 1} 条历史回复，用来检查长会话中的输入和滚动。` });
let nextId = 0, failedProbe = scene === "error", turn = 0;
const sequences = new Map<number, number>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const send = async (sessionId: number, event: CcEvent) => {
  const seq = sequences.get(sessionId) ?? 0; sequences.set(sessionId, seq + 1);
  await emit("cc-event", { seq, sessionId, event });
};
const stored = [{ rowId: 2, connectionId: "", sessionId: "other", cwd: "D:/projects/api-service", title: "梳理 API 错误处理", titleLocked: true, preview: "检查请求失败时的提示", model: "sonnet", permissionMode: "default", messageCount: 4, updatedAt: Date.now() / 1000, archivedAt: null, dropped: 0 }];
mockWindows("main");
mockIPC(async (command, payload = {}) => {
  const args = payload as Record<string, any>;
  if (command === "cc_new_session") return ++nextId;
  if (command === "cc_snapshot") return { events: [], nextSeq: 0, dropped: 0, running: false, resumeId: null };
  if (command === "cc_restore") return args.sessionId === 1 || args.rowId ? { rowId: args.rowId || 1, connectionId: "", cwd: "D:/projects/web-console", model: "opus", permissionMode: "default", sessionId: "review-session", resumeId: "review-session", title: args.rowId ? "梳理 API 错误处理" : "排查登录请求超时", titleLocked: true, messageCount: 2, updatedAt: Date.now() / 1000, events: scene === "empty" ? [] : initial, dropped: 0 } : null;
  if (command === "cc_probe") { const unavailable = failedProbe; failedProbe = false; return { found: !unavailable, path: "C:/tools/claude.exe", version: "2.1", message: unavailable ? "SSH authentication failed: Permission denied (publickey,password)" : "可用", target: "本机" }; }
  if (command === "get_status") return { platform: "windows", running: true, allowedRoots: ["D:/projects"], autoApproveRules: [] };
  if (command === "ssh_list_connections") return { connections: [{ id: "office", name: "公司", host: "example.invalid" }] };
  if (command === "cc_list_stored") return stored;
  if (command === "cc_context_tax") return null;
  if (command === "cc_polish") { await new Promise(resolve => setTimeout(resolve, 400)); return `建议稿：${args.req.draft}`; }
  if (command === "cc_session_backups") return [];
  if (command === "cc_history_list") return { rows: [], total: 0, scanned: 0 };
  if (command === "cc_start") {
    const id = args.sessionId, n = ++turn;
    await send(id, { kind: "init", sessionId: "review-session", cwd: args.req.cwd, model: args.req.model || "opus" });
    await send(id, { kind: "userMessage", text: args.req.text });
    timers.set(id, setTimeout(async () => { await send(id, { kind: "text", blockId: `answer-${n + 1}`, streaming: false, text: `收到：${args.req.text}。\n\n这是正式组件接收测试事件后的回复，用于检查发送、队列和会话切换。` }); await send(id, finish); }, 4000));
    return true;
  }
  if (command === "cc_interrupt") { clearTimeout(timers.get(args.sessionId)); return true; }
  if (command === "cc_respond") { await send(args.sessionId, { kind: "permissionResolved", requestId: args.requestId, decision: args.decision }); return true; }
  if (command === "cc_archive_session") { const row = stored.find(row => row.rowId === args.rowId); if (row) row.archivedAt = args.archived ? Date.now() / 1000 : null; return true; }
  if (command === "cc_rename_session") return args.title;
  if (command === "cc_close_session") return true;
  if (command === "browse_directory") return { path: args.path, parent: null, entries: scene === "files" ? Array.from({ length: 24 }, (_, index) => ({ name: `file-${index + 1}.ts`, path: `${args.path}/file-${index + 1}.ts`, isDir: false })) : [{ name: "README.md", path: "D:/projects/README.md", isDir: false }] };
  return null;
}, { shouldMockEvents: true });
const { CcGuiTab } = await import("../src/components/tabs/CcGuiTab");
const { SideNav } = await import("../src/components/layout/SideNav");
const { ToastProvider } = await import("../src/components/ui/toast");
const { UpdateProvider } = await import("../src/contexts/UpdateContext");
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Review() {
  const [destination, setDestination] = useState("ccgui");
  return <QueryClientProvider client={query}><UpdateProvider><ToastProvider><div className="app-boot-fade bg-background text-foreground" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <div style={{ height: 36, flex: "none", padding: "8px 18px", fontSize: 11, color: "hsl(var(--muted-foreground))" }}>正式组件验收 · 模拟服务 · {destination === "ccgui" ? "对话页" : `已导航至 ${destination}`}</div>
    <div className="app-shell"><SideNav activeTab="ccgui" onNavigate={setDestination} unreadCount={0} collapsed={innerWidth < 850} /><main className="app-main" style={{ padding: innerWidth < 850 ? 8 : 18, display: "flex", flexDirection: "column" }}><CcGuiTab onNavigate={setDestination} /></main></div>
  </div></ToastProvider></UpdateProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Review />);
