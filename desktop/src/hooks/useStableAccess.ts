import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import type { StaticStatus } from "../lib/types";
import type { StableConnectState } from "./useStableConnect";
import { chooseStableTarget, stableAccessIdentity, stableNeedsLogin, stableProjectName, type StableDiscovery, type StableProject, type StableTarget } from "../lib/stableAccess";
import type { StableSetup } from "../lib/stableConnect";

type Picker = "projects" | "entries" | null;
const initial = (key: string) => ({
  key, result: undefined as StableDiscovery | undefined, checking: false, error: "", needsSecret: false, loginVerified: false,
  scope: "project" as "user" | "project", project: undefined as StableProject | undefined,
  targetId: "", picker: null as Picker, multiDevice: false, scoped: false,
  scopeEditing: false, scopeSource: undefined as StableTarget | undefined,
});

/** Stable-only drafts and bounded inspection; no directory/scope writes to the IP-direct preferences. */
export function useStableAccess(stable: StableConnectState, status: StaticStatus | undefined, enabled: boolean, tlsEnabled = false) {
  const key = JSON.stringify([stableAccessIdentity(stable.selectedId, stable.connections, status), tlsEnabled]);
  const [stored, setStored] = useState(() => initial(key));
  const current = stored.key === key ? stored : initial(key);
  const generation = useRef(0);
  const latest = useRef({ stable, key, current, active: enabled });
  latest.current = { stable, key, current, active: enabled };
  const update = (patch: Partial<typeof stored>) => setStored(old => ({ ...(old.key === key ? old : initial(key)), ...patch }));
  const needsInspection = enabled && stable.enabled && !!stable.connection && !stable.busy && !stable.ui.selecting && !stable.ui.dialog
    && (!stable.record?.configured || !stable.ui.managing && (!stable.record.configMatches || stable.ui.verify));

  const inspect = useCallback(async (path?: string, scoped = false, source?: StableTarget, destination?: { scope: "user" | "project"; project?: StableProject }, mode: "normal" | "silent" | "repair" = "normal", multiOverride?: boolean) => {
    const snapshot = latest.current;
    if (!snapshot.active || !snapshot.stable.connection) return;
    const request = ++generation.current;
    const credentials = snapshot.stable.ui.credentialConnectionId === snapshot.stable.selectedId ? snapshot.stable.ui.credentials : {};
    // Loading recent projects must not dismiss a chooser the user just opened.
    const multi = multiOverride ?? (snapshot.stable.record?.configured ? snapshot.stable.record.multiDevice : snapshot.current.multiDevice);
    setStored(old => ({ ...(old.key === snapshot.key ? old : initial(snapshot.key)), checking: true, error: "", needsSecret: false, loginVerified: false, multiDevice: multi,
      ...(multiOverride === undefined ? {} : { targetId: "", picker: null }),
      ...(mode === "repair" ? { picker: null, targetId: "", scopeEditing: false, scopeSource: undefined } :
        source ? { scopeEditing: true, scopeSource: source, targetId: source.id, ...destination } : {}) }));
    try {
      const result = await invoke<StableDiscovery>("stable_connect_inspect", {
        connectionId: snapshot.stable.selectedId, projectPath: path ?? null,
        sourceProjectPath: source ? source.projectPath : null,
        password: credentials.password ?? null, passphrase: credentials.passphrase ?? null,
        multiDevice: multi,
      });
      if (request !== generation.current || latest.current.key !== snapshot.key || !latest.current.active) return;
      const targets = path && !source ? result.targets.filter(target => target.projectPath === result.inspectedProjectPath)
        : mode === "repair" && !source ? result.targets.filter(target => target.scope === snapshot.stable.record?.scope) : result.targets;
      const filtered = { ...result, targets };
      const preferred = multiOverride === undefined ? snapshot.current.targetId || snapshot.stable.record?.target?.id : undefined;
      const target = source ? targets.find(target => target.id === source.id) : mode === "repair" ? undefined : chooseStableTarget(filtered, preferred);
      const selectedPath = target?.projectPath || result.inspectedProjectPath;
      setStored(old => {
        const base = old.key === snapshot.key ? old : initial(snapshot.key);
        // 静默核对只取「服务器上这条接入现在是什么」，供差异提示展示；
        // 不替用户选条目、不改范围草稿，否则启动瞬间的一次读取会把「更改范围」等后续操作指向另一条接入。
        if (mode === "silent") return { ...base, result: filtered, checking: false, error: "", needsSecret: false };
        return { ...base,
          result: filtered, checking: false, error: source && result.complete && !target ? "原接入已变化或不存在，请取消更改并重新检查接入。" : "", needsSecret: false, loginVerified: result.complete && !!(credentials.password || credentials.passphrase), scoped,
          targetId: target?.id ?? source?.id ?? "", scope: destination?.scope ?? (target ? target.scope === "user" ? "user" : "project" : "project"),
          project: destination ? destination.project : selectedPath ? { name: stableProjectName(selectedPath), path: selectedPath } : undefined,
          multiDevice: multi,
          picker: old.picker === "projects" ? "projects" : !source && result.complete && targets.length > 0 && !target ? "entries" : null,
        };
      });
      if (/请输入/.test(snapshot.stable.ui.error) || stableNeedsLogin(snapshot.stable.ui.error)) snapshot.stable.update({ error: "" });
      // 切换方式触发的一次性核对到此结束；再次切换会重新排队。
      if (snapshot.stable.ui.verify) snapshot.stable.update({ verify: false });
    } catch (error) {
      if (request !== generation.current || latest.current.key !== snapshot.key || !latest.current.active) return;
      const message = error instanceof Error ? error.message : String(error);
      const needsSecret = stableNeedsLogin(message);
      if (needsSecret) snapshot.stable.update({ credentials: {} });
      if (snapshot.stable.ui.verify) snapshot.stable.update({ verify: false });
      setStored(old => ({ ...old, checking: false, error: message, needsSecret, loginVerified: false }));
    }
  }, []);

  // Closing the editor ends its draft; late destination reads must not reopen it.
  useEffect(() => {
    if (!enabled) setStored(initial(key));
    return () => { generation.current += 1; };
  }, [key, enabled]);
  useEffect(() => {
    if (stable.compact && latest.current.current.scopeEditing) {
      generation.current++;
      setStored(initial(key));
    }
  }, [stable.compact, key]);
  useEffect(() => {
    if (!needsInspection) return;
    const draft = latest.current.current;
    if (draft.checking) return;
    const stable = latest.current.stable;
    // The editor owns its requests. A background check must never replace an explicit repair with general discovery.
    const silent = !!stable.record?.configured;
    if (silent && !stable.ui.verify && (draft.result || draft.error)) return;
    void inspect(draft.scoped ? draft.project?.path : undefined, draft.scoped,
      draft.scopeSource, draft.scopeEditing ? { scope: draft.scope, project: draft.project } : undefined, silent ? "silent" : "normal");
  }, [key, needsInspection, inspect]);

  const result = current.result;
  const target = result?.targets.find(item => item.id === current.targetId) ?? current.scopeSource;
  const scopeChanged = current.scopeEditing && !!target && (current.scope !== (target.scope === "user" ? "user" : "project")
    || current.scope === "project" && !!current.project && current.project.path !== target.projectPath);
  const failed = !current.checking && (!!current.error || !!result && !result.complete);
  const chooseTarget = (id: string) => {
    const target = result?.targets.find(item => item.id === id);
    if (!target || !result?.complete) return;
    update({ targetId: id, picker: null, scope: target.scope === "user" ? "user" : "project",
      project: target.projectPath ? { name: stableProjectName(target.projectPath), path: target.projectPath } : undefined });
  };
  const chooseProject = (project: StableProject) => {
    update({ scope: "project", project, targetId: current.scopeEditing ? target?.id ?? "" : "", picker: null, scoped: true });
    void inspect(project.path, true, current.scopeSource, current.scopeEditing ? { scope: "project", project } : undefined);
  };
  const chooseScope = (scope: "user" | "project") => {
    if (current.scopeEditing && target) {
      const project = scope === "project" ? current.project ?? (target.projectPath ? { name: stableProjectName(target.projectPath), path: target.projectPath } : undefined) : undefined;
      update({ scope, project, picker: scope === "project" && !project ? "projects" : null, scoped: !!project });
      if (scope === "user" || project) void inspect(project?.path, !!project, target, { scope, project });
      return;
    }
    if (scope === "project") update({ scope, picker: "projects" });
    else {
      update({ scope, project: undefined, picker: null, scoped: false });
      if (current.scoped) void inspect(undefined, false, undefined, { scope });
    }
  };
  const scope = target && !current.scopeEditing ? target.scope === "user" ? "user" : "project" : current.scope;
  const projectPath = target && !current.scopeEditing ? target.projectPath : scope === "project" ? current.project?.path ?? "" : "";
  const setup: StableSetup | undefined = result?.complete && !failed && !current.checking && !current.picker
    && (scope === "user" || projectPath) ? {
      scope, projectPath,
      multiDevice: current.multiDevice,
      access: { target: target ?? null, ...(scopeChanged ? { scopeChange: true } : {}), tunnelPort: result.tunnelPort ?? null, inspection: { signature: result.signature, complete: result.complete,
        files: result.files.filter(file => file.scope === "user" || file.configFile === target?.configFile || file.projectPath === projectPath) } },
    } : undefined;
  const retry = () => void inspect(current.scoped ? current.project?.path : undefined, current.scoped,
    current.scopeSource, current.scopeEditing ? { scope: current.scope, project: current.project } : undefined);
  const observe = () => void inspect(undefined, false, undefined, undefined, "silent");
  const inspectOriginal = () => {
    const source = stable.record?.target;
    // Repair must only write the saved entry, even if the scan finds other compatible entries.
    if (source) void inspect(source.projectPath || undefined, !!source.projectPath, source, undefined, "repair");
    else {
      const path = stable.record?.projectPath || undefined;
      // Old records have no item identity. Ask the user to confirm the entry within its saved scope.
      void inspect(path, !!path, undefined, undefined, "repair");
    }
  };
  const openScope = () => {
    const source = stable.record?.target ?? target;
    stable.update({ managing: true });
    if (!source) return;
    const project = source.projectPath ? { name: stableProjectName(source.projectPath), path: source.projectPath } : undefined;
    void inspect(project?.path, !!project, source, { scope: source.scope === "user" ? "user" : "project", project });
  };
  const cancelScope = () => {
    generation.current++;
    const source = target ?? current.scopeSource;
    update({ scopeEditing: false, scopeSource: undefined, checking: false, error: "", picker: null,
      scope: source?.scope === "user" ? "user" : "project", targetId: source?.id ?? "",
      project: source?.projectPath ? { name: stableProjectName(source.projectPath), path: source.projectPath } : undefined, scoped: !!source?.projectPath });
    if (stable.record?.configured) stable.update({ managing: false, error: "" });
  };
  return {
    ...current, result, target, setup, failed, scopeChanged, picking: !!current.picker, openScope, cancelScope,
    message: current.error || result?.warnings[0] || "", chooseScope, chooseProject, chooseTarget, retry, observe, inspectOriginal,
    openProjects: () => update({ picker: "projects" }), openTargets: () => update({ picker: "entries" }),
    closePicker: () => update({ picker: result?.complete && result.targets.length && !target ? "entries" : null }),
    setMultiDevice: (multiDevice: boolean) => {
      // A different mode uses a different ledger and ownership filter on the server.
      const project = current.project;
      const path = current.scope === "project" ? project?.path : undefined;
      void inspect(path, !!path, undefined,
        { scope: current.scope, project }, "normal", multiDevice);
    },
    apply: async () => {
      if (!setup) return false;
      const success = await stable.start(setup);
      if (success && latest.current.key === key) setStored(initial(key));
      return success;
    },
  };
}
export type StableAccessState = ReturnType<typeof useStableAccess>;
