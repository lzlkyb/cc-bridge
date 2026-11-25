import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { useToast } from "../ui/toast";
import { useRelayStatus } from "../../hooks/useRelayStatus";
import { useRelayWorkbench, type RelayRequestScope, type RelayWorkbenchView } from "../../hooks/useRelayWorkbench";
import { dayKey, isGeneration, isRelayError, loadRelayRates, relayKey, saveRelayRates, type RelayRates } from "../../lib/relayUsage";
import { buildRelaySnippet, formatClock } from "../../lib/relayFormat";
import { invoke } from "../../lib/tauri";
import { copyText } from "../../lib/utils";
import type { RelayLogEntry, RelayProviderChange, RelayProviderResult } from "../../lib/types";
import { useRelayDrift } from "../../hooks/useRelayDrift";
import { RelayAccessCard, RelayAccessSummary } from "./RelayAccessCard";
import { useRelayDeployment } from "./RelayDeploy";
import { useRelaySshAccess } from "./RelaySshAccess";
import { RelayPriceForm } from "./RelayPriceForm";
import { RelayRequestDetails } from "./RelayRequestDetails";
import { RelayRequestTable } from "./RelayRequestTable";
import { RelayRoute } from "./RelayRoute";
import { RelaySidePanel } from "./RelaySidePanel";
import { RelayUpstreamCard } from "./RelayUpstreamCard";
import { RelayProviderMenu, RelayProviderSettings, type RelayProviderTests } from "./RelayProviderSettings";
import { latestRelayFailure, RelayFailureNotice, relayFailureTitle } from "./RelayDiagnostics";
import { RelayUsageView } from "./RelayUsageView";
import "./relay.css";
import "./relay-workbench.css";

type Action = "start" | "stop" | "restart";
type Surface = { kind: "provider" | "guide" | "stop" } | { kind: "migrate"; fromGuide?: boolean } | { kind: "detail" | "pricing"; row?: RelayLogEntry };
const ACTION_LABEL = { start: "正在启动", stop: "正在停止", restart: "正在重启" };

export function RelayTab({ onNavigate }: { onNavigate?: (tab: string, anchor?: string) => void }) {
  const { status, history, rows, today } = useRelayStatus();
  const snapshot = status.data;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const providerChange = useMutation({ mutationFn: async (change: RelayProviderChange) => {
    const result = await invoke<RelayProviderResult>("relay_manage_provider", { change });
    await queryClient.cancelQueries({ queryKey: ["relay"], exact: true });
    queryClient.setQueryData(["relay"], result.snapshot);
    if (change.action === "activate") setSelected(null);
    return result;
  } });
  const { view, setView, usage, setUsage, requests, setRequests } = useRelayWorkbench();
  const [providerTests, setProviderTests] = useState<RelayProviderTests>({});
  const [surface, setSurface] = useState<Surface | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rates, setRates] = useState(loadRelayRates);
  const [serviceAction, setServiceAction] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<{ action: Action; text: string } | null>(null);
  const operating = useRef(false);
  const todayRows = useMemo(() => rows.filter((row) => dayKey(row.tsMs) === today), [rows, today]);

  const running = snapshot?.running ?? false;
  const configured = snapshot?.provider?.configured ?? false;
  const direct = Boolean(snapshot && snapshot.listenHost !== "127.0.0.1");
  // Upstream probes travel separately from client requests. Verification only uses client traffic.
  const runtimeRows = snapshot?.recent.filter(isGeneration) ?? [];
  const verified = snapshot?.clientVerified ?? runtimeRows.some((row) => row.status != null && row.status >= 200 && row.status < 300 && !row.error);
  const failure = latestRelayFailure(snapshot);
  const badge = serviceAction ? { label: ACTION_LABEL[serviceAction], tone: "accent" }
    : !snapshot ? { label: status.isError ? "状态不可用" : "正在读取状态", tone: "mute" }
    : !running ? { label: "已停止", tone: "mute" }
    : !configured ? { label: "未配置上游", tone: "warn" }
    : failure ? { label: relayFailureTitle(failure), tone: "warn" }
    : !verified ? { label: "等待首个成功请求", tone: "accent" }
    : { label: direct ? "运行中 · 内网开放" : "运行中", tone: direct ? "warn" : "ok" };

  const refresh = () => status.refetch();
  const changeService = async (kind: Action) => {
    if (operating.current) return;
    operating.current = true;
    setSurface(null);
    setServiceAction(kind);
    setActionError(null);
    try {
      await invoke(`relay_${kind}`);
      await status.refetch({ throwOnError: true });
      toast(kind === "stop" ? "中转已停止，配置与历史记录已保留。" : "中转已开始监听。", "success");
    } catch (error) {
      setActionError({ action: kind, text: String(error) });
      void refresh();
    } finally {
      operating.current = false;
      setServiceAction(null);
    }
  };
  const close = () => setSurface(null);
  const openProvider = () => setSurface({ kind: "provider" });
  const readyForGuide = running && configured && !serviceAction;
  const caption = !snapshot ? "正在读取中转服务与历史记录。"
    : !running ? "配置和历史记录已保留，启动后即可继续接入。"
    : !configured ? "填写上游地址、API 密钥和默认模型，准备接收客户端请求。"
    : !verified && !failure ? "接入 Claude Code 后发送一条模型请求，回到这里验证结果。"
    : "查看客户端请求实际转往哪个模型，再按请求排查状态与用量。";

  const access = useRelaySshAccess(Boolean(snapshot));
  const deployment = useRelayDeployment(access.connection?.id, Boolean(snapshot));
  const baseUrl = direct && snapshot ? `http://${snapshot.listenHost}:${snapshot.port}`
    : access.port ? `http://127.0.0.1:${access.port}` : "";
  const openGuide = () => setSurface({ kind: "guide" });
  const copyConfig = () => {
    const model = snapshot?.tiers.find((tier) => tier.tier === "default")?.alias;
    if (!snapshot?.token || !baseUrl || !model) return;
    void copyText(buildRelaySnippet({ baseUrl, token: snapshot.token, model }),
      () => toast("已复制当前远端配置。", "success"), () => { openGuide(); toast("复制失败，请在接入指南中手动复制。", "error"); });
  };
  const receipt = deployment.lastDeploy.data;
  const drift = useRelayDrift({
    receipt, connectionId: access.connection?.id, currentUrl: baseUrl, direct: direct && readyForGuide,
    onRefresh: refresh,
    onNeedGuide: openGuide,
  });
  const busy = deployment.isPending || Boolean(drift.stage) || access.pending;
  const serviceBlocked = busy || providerChange.isPending;

  const viewTab = (next: RelayWorkbenchView, label: string) => <button id={`relay-tab-${next}`} type="button" role="tab"
    aria-selected={next === view} aria-controls={`relay-view-${next}`} tabIndex={view === next ? 0 : -1}
    onClick={() => setView(next)}><Icon name={next === "route" ? "gitBranch" : "activity"} size={16} />{label}</button>;
  const openRequest = (row: RelayLogEntry) => {
    if (view === "route") setSelected(relayKey(row));
    setSurface({ kind: "detail", row });
  };
  const surfacedRow = surface && "row" in surface ? surface.row : undefined;
  const focusedRow = surfacedRow && (rows.find((row) => relayKey(row) === relayKey(surfacedRow)) ?? surfacedRow);
  const saveRates = (next: RelayRates) => {
    try {
      saveRelayRates(next);
      setRates(next);
      close();
      toast("已保存 Token 单价。", "success");
    } catch {
      toast("保存单价失败，请检查本机存储。", "error");
    }
  };

  return <div className="relay-workbench">
    <header className="relay-work-head">
      <div><div className="relay-inline relay-wrap"><h1>模型中转</h1><span role="status" className="relay-work-badge relay-service-badge" data-tone={badge.tone}>{badge.label}</span>
      </div><p>{caption}</p></div>
      {snapshot && <div className="relay-inline relay-wrap">
        <RelayProviderMenu snapshot={snapshot} tests={providerTests} disabled={Boolean(serviceAction) || serviceBlocked} onActivate={(id) => {
          void providerChange.mutateAsync({ action: "activate", id }).then((result) => toast(`已切换到 ${result.snapshot.provider?.name ?? "上游"}。`, "success"),
            (error) => toast(`切换上游失败：${String(error)}`, "error"));
        }} />
        <Button variant="outline" size="sm" onClick={openProvider} disabled={Boolean(serviceAction) || serviceBlocked}><Icon name="settings" size={14} />上游设置</Button>
        <Button size="sm" variant={running || serviceAction === "stop" ? "outline" : "default"}
          className={running || serviceAction === "stop" ? "relay-service-stop" : undefined}
          disabled={serviceBlocked} isLoading={Boolean(serviceAction)} loadingText={serviceAction ? ACTION_LABEL[serviceAction] : undefined}
          onClick={() => running ? setSurface({ kind: "stop" }) : void changeService("start")}>
          <Icon name={running ? "pause" : "play"} size={14} />{running ? "停止中转" : "启动中转"}</Button>
        {running && <Menu trigger={(open, toggle) => <Button variant="outline" size="icon" aria-label="中转服务操作" aria-haspopup="menu" aria-expanded={open} disabled={Boolean(serviceAction) || serviceBlocked} onClick={toggle}><Icon name="more" size={17} /></Button>}>
          {(dismiss) => <MenuItem icon="refresh" label="重启中转" onClick={() => { dismiss(); void changeService("restart"); }} />}
        </Menu>}
      </div>}
    </header>

    {snapshot && <RelayAccessSummary access={access} deployment={deployment} baseUrl={baseUrl} direct={direct}
      verified={verified} disabled={Boolean(serviceAction || drift.stage) || status.isError} onOpen={openGuide}
      prerequisite={readyForGuide ? undefined : !running || serviceAction ? { title: serviceAction ? `${ACTION_LABEL[serviceAction]}中转` : "中转已停止，启动后可继续接入。",
        action: "启动中转", run: () => void changeService("start") } : { title: "完成上游配置后即可部署远端客户端。", action: "配置上游", run: openProvider }} />}
    {failure && !serviceAction && <RelayFailureNotice result={failure} row={failure.requestId ? rows.find((row) => row.requestId === failure.requestId) : undefined}
      onRequest={openRequest} openGuide={openGuide} openProvider={openProvider} copyConfig={direct && baseUrl && snapshot?.token ? copyConfig : undefined} disabled={serviceBlocked || status.isError} />}

    {drift.drift && receipt && (
      <div className="relay-work-notice" role="alert">
        <strong>本机地址已变，远端配置需更新</strong>
        <span>{access.connection?.username} 的上次部署地址是 <code>{receipt.url}</code>，本机现为 <code>{baseUrl}</code>。</span>
        <div className="relay-drift-actions">
          <Button size="sm" disabled={busy} onClick={() => void drift.change("deploy")}>一键重新部署</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setSurface({ kind: "migrate" })}>切隧道并重新部署</Button>
        </div>
      </div>
    )}
    {drift.stage && <p className="relay-access-feedback" role="status"><span className="relay-access-spinner" aria-hidden="true" />{drift.stage}</p>}
    {drift.error && <p className="relay-access-feedback" role="alert">接入操作未完成。{drift.error}</p>}

    <div className="relay-work-tabs" role="tablist" aria-label="模型中转视图" onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "route" : event.key === "End" ? "usage" : view === "route" ? "usage" : "route";
      setView(next);
      document.getElementById(`relay-tab-${next}`)?.focus();
    }}>{viewTab("route", "请求路由")}{viewTab("usage", "Token 用量")}</div>

    {status.isError && <div className="relay-work-notice relay-inline relay-spread" role="alert"><div><strong>读不到中转状态</strong>
      <span>{status.dataUpdatedAt ? `当前显示 ${formatClock(status.dataUpdatedAt)} 的最后一次快照。` : "本机中转暂时没有返回状态。"}</span></div><Button size="sm" variant="outline" onClick={refresh}>重试</Button></div>}
    {history.isError && <div className="relay-work-notice relay-inline relay-spread" role="alert"><div><strong>读取中转历史失败</strong><span>{history.data ? "已保留上一次读取到的记录。" : "当前只显示进程中的最近请求，汇总可能不完整。"}</span></div>
      <Button size="sm" variant="outline" onClick={() => void history.refetch()}>重试</Button></div>}
    {actionError && <div className="relay-work-notice relay-inline relay-spread" role="alert"><div><strong>中转操作失败</strong><span>{actionError.text}</span></div>
      <Button size="sm" variant="outline" onClick={() => actionError.action === "stop" ? setSurface({ kind: "stop" }) : void changeService(actionError.action)}>重试</Button></div>}

    <section key={view} id={`relay-view-${view}`} className="relay-work-view" role="tabpanel" aria-labelledby={`relay-tab-${view}`} aria-busy={!snapshot && !status.isError || undefined}>
      {view === "usage" ? history.isPending ? <div className="relay-work-panel relay-table-empty" role="status">正在读取近 7 天的中转用量…</div>
        : <RelayUsageView rows={rows} today={today} scope={usage} rates={rates} onScope={setUsage}
          onRequest={openRequest} onPricing={() => setSurface({ kind: "pricing" })} /> : snapshot ? <div className="relay-work-stack">
        {!configured && surface?.kind !== "provider" && <section className="relay-work-panel relay-setup"><RelayUpstreamCard snapshot={snapshot} onChanged={refresh} /></section>}
        <RelayRoute snapshot={snapshot} todayRows={todayRows} selected={rows.find((row) => relayKey(row) === selected)}
          busy={Boolean(serviceAction)} onClear={() => setSelected(null)} onUsage={() => { setUsage({ range: { mode: "today", from: today, to: today }, bucket: null }); setView("usage"); }} />
        <RelayRecentRequests todayRows={todayRows} historyRows={rows} rates={rates} scope={requests} onScope={setRequests} selected={selected} onRequest={openRequest} />
      </div> : !status.isError && <div className="relay-work-panel relay-table-empty" role="status">正在读取模型中转…</div>}
    </section>

    {surface?.kind === "provider" && snapshot && <RelayProviderSettings snapshot={snapshot} onClose={close} mutate={providerChange.mutateAsync} busy={providerChange.isPending}
      tests={providerTests} remember={(id, outcome) => setProviderTests((current) => {
        const next = { ...current };
        if (outcome) next[id] = outcome;
        else delete next[id];
        return next;
      })} />}
    {surface?.kind === "guide" && snapshot && <RelaySidePanel title="接入指南" onClose={close} compact>
      <RelayAccessCard snapshot={snapshot} access={access} deployment={deployment} baseUrl={baseUrl} onChanged={refresh}
        blocked={Boolean(serviceAction || drift.stage) || status.isError} onMigrate={() => setSurface({ kind: "migrate", fromGuide: true })}
        onStart={() => void changeService("start")} onConfigure={openProvider} onRequests={() => {
          close(); setView("route"); setRequests({ errors: false, full: false }); setSelected(null);
          window.requestAnimationFrame(() => document.getElementById("relay-requests-heading")?.focus());
        }}
        onManageSsh={onNavigate && ((anchor) => { close(); onNavigate("terminal", anchor); })}
        onOpenTerminal={onNavigate && ((id) => { close(); onNavigate("terminal", `relay-ssh:${id}`); })} />
    </RelaySidePanel>}
    {surface?.kind === "migrate" && <ConfirmDialog title="切到隧道并重新部署？"
      description="切换接入方式会重启中转，进行中的请求可能中断。完成后会为当前账号建立转发并更新远端配置。"
      confirmLabel="切到隧道" onCancel={surface.fromGuide ? openGuide : close} onConfirm={() => { close(); void drift.change("tunnel"); }} />}
    {surface?.kind === "detail" && focusedRow && <RelaySidePanel title="请求详情" onClose={close}><RelayRequestDetails row={focusedRow} rates={rates}
      onPricing={() => setSurface({ kind: "pricing", row: focusedRow })} /></RelaySidePanel>}
    {surface?.kind === "pricing" && <RelaySidePanel title="Token 单价" onClose={close}><RelayPriceForm rows={rows} initial={focusedRow} rates={rates} onSave={saveRates} /></RelaySidePanel>}
    {surface?.kind === "stop" && <ConfirmDialog title="停止中转？" description="停止监听将中断进行中的请求。配置与历史记录会保留。"
      confirmLabel="停止中转" variant="destructive" onCancel={close} onConfirm={() => void changeService("stop")} />}
  </div>;
}

function RelayRecentRequests({ todayRows, historyRows, rates, scope, onScope, selected, onRequest }: {
  todayRows: RelayLogEntry[]; historyRows: RelayLogEntry[]; rates: RelayRates; scope: RelayRequestScope;
  onScope: (patch: Partial<RelayRequestScope>) => void;
  selected: string | null; onRequest: (row: RelayLogEntry) => void;
}) {
  const { errors, full, page } = scope;
  const rows = full ? historyRows : todayRows;
  return <section className="relay-work-panel" aria-labelledby="relay-requests-heading">
      <header className="relay-section-head"><div><h2 id="relay-requests-heading" tabIndex={-1}>{full ? "完整请求" : "最近请求"}</h2><p>{full ? "最近 7 天的模型请求与 Token 预估请求。" : "选择一条记录，查看路由和 Token 明细。"}</p></div>
        <div className="relay-inline relay-wrap"><div className="relay-seg" role="group" aria-label="请求结果筛选">
          <button type="button" aria-pressed={!errors} onClick={() => onScope({ errors: false })}>全部</button>
          <button type="button" aria-pressed={errors} onClick={() => onScope({ errors: true })}>仅异常</button>
        </div><Button size="sm" variant="ghost" onClick={() => onScope({ full: !full })}>{full ? "返回最近请求" : "完整请求"}<Icon name={full ? "chevronLeft" : "chevronRight"} size={13} /></Button></div>
      </header>
      <RelayRequestTable rows={errors ? rows.filter(isRelayError) : rows} rates={rates} dated={full} selected={selected} onRequest={onRequest} requestedPage={page} onPage={(next) => onScope({ page: next })}
        empty={errors ? "没有符合筛选条件的异常请求。" : full ? "近 7 天没有请求记录。" : "今天还没有请求记录。"} />
      <p className="relay-work-footnote">经 SSH 隧道接入的请求归入「回环」。</p>
  </section>;
}
