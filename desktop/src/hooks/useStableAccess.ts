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
    && (!stable.record?.configured || stable.ui.managing || !stable.record.configMatches);

  const inspect = useCallback(async (path?: string, scoped = false, source?: StableTarget, destination?: { scope: "user" | "project"; project?: StableProject }) => {
    const snapshot = latest.current;
    if (!snapshot.active || !snapshot.stable.connection) return;
    const request = ++generation.current;
    const credentials = snapshot.stable.ui.credentialConnectionId === snapshot.stable.selectedId ? snapshot.stable.ui.credentials : {};
    // Loading recent projects must not dismiss a chooser the user just opened.
    setStored(old => ({ ...(old.key === snapshot.key ? old : initial(snapshot.key)), checking: true, error: "", needsSecret: false, loginVerified: false,
      ...(source ? { scopeEditing: true, scopeSource: source, targetId: source.id, ...destination } : {}) }));
    try {
      const result = await invoke<StableDiscovery>("stable_connect_inspect", {
        connectionId: snapshot.stable.selectedId, projectPath: path ?? null,
        sourceProjectPath: source ? source.projectPath : null,
        password: credentials.password ?? null, passphrase: credentials.passphrase ?? null,
      });
      if (request !== generation.current || latest.current.key !== snapshot.key || !latest.current.active) return;
      const targets = path && !source ? result.targets.filter(target => target.projectPath === result.inspectedProjectPath) : result.targets;
      const filtered = { ...result, targets };
      const preferred = snapshot.current.targetId || snapshot.stable.record?.target?.id;
      const target = source ? targets.find(target => target.id === source.id) : chooseStableTarget(filtered, preferred);
      const selectedPath = target?.projectPath || result.inspectedProjectPath;
      setStored(old => ({ ...(old.key === snapshot.key ? old : initial(snapshot.key)),
        result: filtered, checking: false, error: source && result.complete && !target ? "原接入已变化或不存在，请取消更改并重新检查接入。" : "", needsSecret: false, loginVerified: result.complete && !!(credentials.password || credentials.passphrase), scoped,
        targetId: target?.id ?? source?.id ?? "", scope: destination?.scope ?? (target ? target.scope === "user" ? "user" : "project" : "project"),
        project: destination ? destination.project : selectedPath ? { name: stableProjectName(selectedPath), path: selectedPath } : undefined,
        multiDevice: target ? snapshot.stable.record?.multiDevice ?? false : snapshot.current.multiDevice,
        picker: old.picker === "projects" ? "projects" : !source && result.complete && targets.length > 0 && !target ? "entries" : null,
      }));
      if (/请输入/.test(snapshot.stable.ui.error) || stableNeedsLogin(snapshot.stable.ui.error)) snapshot.stable.update({ error: "" });
    } catch (error) {
      if (request !== generation.current || latest.current.key !== snapshot.key || !latest.current.active) return;
      const message = error instanceof Error ? error.message : String(error);
      const needsSecret = stableNeedsLogin(message);
      if (needsSecret) snapshot.stable.update({ credentials: {} });
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
    if (needsInspection) {
      const draft = latest.current.current;
      if (!draft.checking) void inspect(draft.scoped ? draft.project?.path : undefined, draft.scoped,
        draft.scopeSource, draft.scopeEditing ? { scope: draft.scope, project: draft.project } : undefined);
    }
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
      multiDevice: scope === "user" && (target ? stable.record?.multiDevice ?? false : current.multiDevice),
      access: { target: target ?? null, ...(scopeChanged ? { scopeChange: true } : {}), inspection: { signature: result.signature, complete: result.complete,
        files: result.files.filter(file => file.scope === "user" || file.configFile === target?.configFile || file.projectPath === projectPath) } },
    } : undefined;
  const retry = () => void inspect(current.scoped ? current.project?.path : undefined, current.scoped,
    current.scopeSource, current.scopeEditing ? { scope: current.scope, project: current.project } : undefined);
  const openScope = () => {
    const source = target ?? stable.record?.target;
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
    message: current.error || result?.warnings[0] || "", chooseScope, chooseProject, chooseTarget, retry,
    openProjects: () => update({ picker: "projects" }), openTargets: () => update({ picker: "entries" }),
    closePicker: () => update({ picker: result?.complete && result.targets.length && !target ? "entries" : null }),
    setMultiDevice: (multiDevice: boolean) => update({ multiDevice }),
    apply: () => { if (setup) void stable.start(setup).then(success => {
      if (success && latest.current.key === key) setStored(initial(key));
    }); },
  };
}
export type StableAccessState = ReturnType<typeof useStableAccess>;
