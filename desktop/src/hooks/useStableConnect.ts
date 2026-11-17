import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { SshConnection, SshConnectionList, StaticStatus } from "../lib/types";
import type { SshOneTimeCredentials } from "../lib/sshConnectionForm";
import { stableConnectCommand, stableSetupMatches, stableProgressIndex, stableProgressLabels, type ConnectionMethod, type StableConnectSnapshot, type StableSetup } from "../lib/stableConnect";
import { stableConnectKey, useStableConnectSnapshot } from "./useStableConnectSnapshot";
import type { ConnectAutomation } from "../components/tabs/connect/ConnectCommand";
import { stableSavedSetup } from "../lib/stableAccess";
import { toast } from "../components/ui/toast";

const emptyUi = { managing: false, dialog: false, editing: false, error: "", pending: false, cancelling: false, selecting: false, credentials: {} as SshOneTimeCredentials, credentialConnectionId: "", nextStepConnectionId: "", verify: false, fromDirect: false };
export function useStableConnect(status: StaticStatus | undefined, draft?: StableSetup) {
  const snapshot = useStableConnectSnapshot(status);
  const client = useQueryClient();
  const servers = useQuery({ queryKey: ["sshConnections"], queryFn: () => invoke<SshConnectionList>("ssh_list_connections") });
  const [ui, setUi] = useState(emptyUi);
  const lock = useRef(false);
  const cancelRequested = useRef(false);
  const connections = servers.data?.connections ?? [];
  const selectedConnectionId = snapshot.data?.selectedConnectionId ?? "";
  const selectedId = selectedConnectionId || connections[0]?.id || "";
  const connection = connections.find(c => c.id === selectedId);
  const record = snapshot.data?.connections.find(c => c.connectionId === selectedId);
  const setup = draft ?? stableSavedSetup(record);
  const method = snapshot.data?.method ?? "direct";
  const busy = ui.pending || record?.phase === "running";
  const changed = !!record?.configured && !stableSetupMatches(record, setup);
  const ready = record?.phase === "ready" && !changed && !!status?.running;
  const showNextStep = ready && ui.nextStepConnectionId === selectedId;
  const reconnecting = record?.phase === "reconnecting";
  const compact = !!record?.configured && !busy && !ui.managing;
  const previousPhase = useRef(record?.phase);
  useEffect(() => {
    if (record?.phase === "ready" && previousPhase.current === "running") setUi(prev => ({ ...prev, managing: false, credentials: {} }));
    previousPhase.current = record?.phase;
  }, [record?.phase]);
  // 冷启动时隧道会自动恢复，但「服务器上的接入指向哪里」只有核对才知道：
  // 记录里存的是上次写入时的值，服务器可能已被改成直连地址。不核对就会沿用旧结论显示「已连通」。
  // 每个进程对每个连接只自动核对一次，避免反复登录服务器。
  const autoChecked = useRef(new Set<string>());
  useEffect(() => {
    if (method !== "stable" || !record?.configured || record.phase !== "ready") return;
    if (autoChecked.current.has(selectedId)) return;
    autoChecked.current.add(selectedId);
    setUi(prev => ({ ...prev, verify: true }));
  }, [method, record?.configured, record?.phase, selectedId]);
  const update = (patch: Partial<typeof ui>) => setUi(prev => ({ ...prev, ...patch, ...(patch.credentials ? { credentialConnectionId: patch.credentialConnectionId ?? selectedId } : {}) }));
  const refresh = () => client.invalidateQueries({ queryKey: stableConnectKey }, { throwOnError: true });
  const select = async (next: ConnectionMethod, id?: string) => {
    if (lock.current || busy) return false;
    lock.current = true; update({ selecting: true, error: "", credentials: {}, nextStepConnectionId: "" });
    try {
      const fromDirect = next === "stable" && (method === "direct" || ui.fromDirect);
      // A direct address describes the local listener, not the SSH server. Only reuse a saved server choice.
      await invoke("stable_connect_select", { method: next, connectionId: (id ?? selectedConnectionId) || null });
      update({ fromDirect });
      await refresh();
      // 切换方式只写本地偏好，服务器上的条目一个字节都没动。切到隧道时排一次核对，
      // 但不动 managing：紧凑视图保持不变，核对结果回来后再决定要不要提示更新接入。
      update({ managing: false, verify: next === "stable" });
      return true;
    } catch (e) { update({ error: `切换连接方式失败：${e}` }); return false; }
    finally { lock.current = false; update({ selecting: false }); }
  };
  const start = async (override?: StableSetup) => {
    if (lock.current || busy) return;
    if (!connection) { update({ error: "请先添加并选择服务器。" }); return; }
    if (!status?.running) { update({ error: "本机服务已停止，请先启动服务。" }); return; }
    const request = override ?? setup;
    if (request.scope === "project" && !request.projectPath.trim()) { update({ error: "请先选择服务器上的项目文件夹。" }); return; }
    const credentials = ui.credentialConnectionId === selectedId ? ui.credentials : {};
    if (record?.needsSecret && !credentials.password && !credentials.passphrase) { update({ managing: true, error: "请输入服务器密码或密钥口令后继续。" }); return; }
    lock.current = true; cancelRequested.current = false;
    update({ pending: true, cancelling: false, error: "" });
    let succeeded = false;
    // Snapshot the selected server and credentials for this attempt; never cache secrets.
    update({ credentials: {} });
    try {
      const result = await invoke<StableConnectSnapshot>("stable_connect_start", { connectionId: selectedId, ...request, access: request.access ?? null, projectPath: request.scope === "user" ? "" : request.projectPath.trim(), password: credentials.password ?? null, passphrase: credentials.passphrase ?? null });
      const outcome = result.connections.find(c => c.connectionId === selectedId);
      succeeded = outcome?.phase === "ready" && !cancelRequested.current;
      if (cancelRequested.current) {
        update({ managing: false });
      } else if (succeeded) {
        // A successful configuration check does not prove Claude Code has opened the MCP connection.
        update({ managing: false, ...(!record?.configured || !!request.access ? { nextStepConnectionId: selectedId } : {}) });
      } else if (record?.configured && !request.access && outcome?.phase === "reconnecting"
        && outcome.configured && outcome.enabled && outcome.configMatches) {
        // Accepted recovery is already supervised; close the form without claiming connectivity.
        update({ managing: false });
      }
    } catch (e) { update({ error: `接入失败：${e}`, managing: true }); }
    finally {
      lock.current = false; update({ pending: false, cancelling: false });
      try { await refresh(); } catch (e) { update({ error: `无法刷新接入结果，请重新读取：${e}` }); }
    }
    return succeeded;
  };
  const stop = async () => {
    try { await invoke("stable_connect_stop", { connectionId: selectedId }); await refresh(); }
    catch (e) { update({ error: `停止失败：${e}` }); }
  };
  const cancel = async () => {
    if (cancelRequested.current || record?.phase !== "running") return;
    cancelRequested.current = true;
    update({ cancelling: true });
    try {
      await invoke("stable_connect_cancel", { connectionId: selectedId });
      if (record.step >= 3) toast("服务器配置可能已写入，请重新检查接入。", "warning");
    }
    catch (e) { cancelRequested.current = false; update({ cancelling: false, error: `取消失败：${e}` }); }
  };
  const saved = async (server: SshConnection, credentials: SshOneTimeCredentials) => {
    await client.invalidateQueries({ queryKey: ["sshConnections"] });
    if (await select("stable", server.id)) update({ credentials, credentialConnectionId: server.id, dialog: false });
  };
  const error = ui.error || (snapshot.error ? `无法读取连接状态：${snapshot.error.message}` : servers.error ? `无法读取服务器列表：${servers.error.message}` : "");
  const automation: ConnectAutomation = {
    busy, ready, configured: !!record?.configured, copyDisabled: !record?.configured || changed || busy,
    cancelDisabled: ui.cancelling || record?.phase !== "running",
    disabled: ready || reconnecting || ui.selecting || snapshot.isPending || servers.isPending || !servers.data?.enabled,
    label: busy ? `正在${stableProgressLabels[stableProgressIndex(record?.step ?? 0)]}…` : reconnecting ? "自动重连中…" : changed ? "应用接入配置" : ready ? "配置完成" : record?.needsSecret ? "继续接入" : record?.phase === "error" ? "重新检测" : record?.phase === "stopped" ? "重新接入" : "一键接入",
    message: error || (changed ? "接入配置已更改，点击「应用接入配置」后生效。" : undefined),
    onStart: () => void start(), onCancel: () => void cancel(), showNextStep,
    onDismissNextStep: () => update({ nextStepConnectionId: "" }),
  };
  return { method, snapshot: snapshot.data, record, connection, connections, selectedId, selectedConnectionId, busy, ready, compact, reconnecting, showNextStep, ui, update, select, start, stop, cancel, saved, automation, serviceRunning: !!status?.running,
    command: stableConnectCommand(record, status, setup), enabled: servers.data?.enabled ?? false, loading: snapshot.isPending || servers.isPending,
    error, retry: () => { void snapshot.refetch(); void servers.refetch(); } };
}
export type StableConnectState = ReturnType<typeof useStableConnect>;
