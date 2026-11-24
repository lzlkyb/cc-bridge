import { useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { useToast } from "../ui/toast";
import { useRelayStatus } from "../../hooks/useRelayStatus";
import { dayKey, isGeneration, isPending, isRelayError, loadRelayRates, relayKey, saveRelayRates, type RelayRates } from "../../lib/relayUsage";
import { formatClock } from "../../lib/relayFormat";
import { invoke } from "../../lib/tauri";
import type { RelayLogEntry } from "../../lib/types";
import { RelayAccessCard } from "./RelayAccessCard";
import { RelayPriceForm } from "./RelayPriceForm";
import { RelayRequestDetails } from "./RelayRequestDetails";
import { RelayRequestTable } from "./RelayRequestTable";
import { RelayRoute } from "./RelayRoute";
import { RelaySidePanel } from "./RelaySidePanel";
import { RelayUpstreamCard } from "./RelayUpstreamCard";
import { RelayUsageView } from "./RelayUsageView";
import "./relay.css";
import "./relay-workbench.css";

type View = "route" | "usage";
type Action = "start" | "stop" | "restart";
type Surface = { kind: "provider" | "guide" | "stop" } | { kind: "detail" | "pricing"; row?: RelayLogEntry };
const ACTION_LABEL = { start: "正在启动", stop: "正在停止", restart: "正在重启" };

export function RelayTab() {
  const { status, history, rows, today } = useRelayStatus();
  const snapshot = status.data;
  const { toast } = useToast();
  const [view, setView] = useState<View>("route");
  const [period, setPeriod] = useState<"week" | "today">("week");
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
  const latest = runtimeRows.find((row) => !isPending(row));
  const verified = snapshot?.clientVerified ?? runtimeRows.some((row) => row.status != null && row.status >= 200 && row.status < 300 && !row.error);
  const latestStatus = snapshot?.latestClientStatus === undefined ? latest?.status : snapshot.latestClientStatus;
  const limited = running && latestStatus === 429;
  const badge = serviceAction ? { label: ACTION_LABEL[serviceAction], tone: "accent" }
    : !snapshot ? { label: status.isError ? "状态不可用" : "正在读取状态", tone: "mute" }
    : !running ? { label: "已停止", tone: "mute" }
    : !configured ? { label: "未配置上游", tone: "warn" }
    : limited ? { label: "上游限流", tone: "warn" }
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
  const readyForGuide = running && configured && !serviceAction;
  const caption = !snapshot ? "正在读取中转服务与历史记录。"
    : !running ? "配置和历史记录已保留，启动后即可继续接入。"
    : !configured ? "填写上游地址、API 密钥和默认模型，准备接收客户端请求。"
    : !verified && !limited ? "接入 Claude Code 后发送一条模型请求，回到这里验证结果。"
    : "查看客户端请求实际转往哪个模型，再按请求排查状态与用量。";

  const viewTab = (next: View, label: string) => <button id={`relay-tab-${next}`} type="button" role="tab"
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
      <div><div className="relay-inline relay-wrap"><h1>模型中转</h1><span role="status" className="relay-work-badge relay-service-badge" data-tone={badge.tone}>{badge.label}</span></div><p>{caption}</p></div>
      {snapshot && <div className="relay-inline relay-wrap">
        {configured && <Button variant="outline" size="sm" onClick={() => setSurface({ kind: "provider" })} disabled={Boolean(serviceAction)}><Icon name="settings" size={14} />上游设置</Button>}
        {!running || serviceAction ? <Button size="sm" isLoading={Boolean(serviceAction)} loadingText={serviceAction ? ACTION_LABEL[serviceAction] : undefined}
          onClick={() => void changeService("start")}><Icon name="play" size={14} />启动中转</Button>
          : configured ? <Button size="sm" disabled={!readyForGuide} onClick={() => setSurface({ kind: "guide" })}><Icon name="plug" size={14} />接入指南</Button>
            : <Button size="sm" onClick={() => { setView("route"); window.requestAnimationFrame(() => document.getElementById("relay-base-url")?.focus()); }}><Icon name="settings" size={14} />配置上游</Button>}
        {running && !serviceAction && <Menu trigger={(open, toggle) => <Button variant="outline" size="icon" aria-label="中转服务操作" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={17} /></Button>}>
          {(dismiss) => <><MenuItem icon="refresh" label="重启中转" onClick={() => { dismiss(); void changeService("restart"); }} />
            <MenuItem icon="pause" label="停止中转" onClick={() => { dismiss(); setSurface({ kind: "stop" }); }} /></>}
        </Menu>}
      </div>}
    </header>

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

    <section id={`relay-view-${view}`} role="tabpanel" aria-labelledby={`relay-tab-${view}`} aria-busy={!snapshot && !status.isError || undefined}>
      {view === "usage" ? history.isPending ? <div className="relay-work-panel relay-table-empty" role="status">正在读取近 7 天的中转用量…</div>
        : <RelayUsageView rows={rows} today={today} initialPeriod={period} rates={rates} onPeriodChange={setPeriod}
          onRequest={openRequest} onPricing={() => setSurface({ kind: "pricing" })} /> : snapshot ? <div className="relay-work-stack">
        {!configured && <section className="relay-work-panel relay-setup"><RelayUpstreamCard snapshot={snapshot} onChanged={refresh} /></section>}
        <RelayRoute snapshot={snapshot} todayRows={todayRows} selected={rows.find((row) => relayKey(row) === selected)}
          busy={Boolean(serviceAction)} onClear={() => setSelected(null)} onUsage={() => { setPeriod("today"); setView("usage"); }} />
        <RelayRecentRequests todayRows={todayRows} historyRows={rows} rates={rates} limited={limited} selected={selected} onRequest={openRequest}
          onGuide={readyForGuide ? () => setSurface({ kind: "guide" }) : undefined} />
      </div> : !status.isError && <div className="relay-work-panel relay-table-empty" role="status">正在读取模型中转…</div>}
    </section>

    {surface?.kind === "provider" && snapshot && <RelaySidePanel title="上游设置" onClose={close}><RelayUpstreamCard snapshot={snapshot} onChanged={refresh} explicit onApplied={() => { close(); toast("上游配置已应用。", "success"); }} /></RelaySidePanel>}
    {surface?.kind === "guide" && snapshot && <RelaySidePanel title="接入指南" onClose={close}><RelayAccessCard snapshot={snapshot} onChanged={refresh} verified={verified} /></RelaySidePanel>}
    {surface?.kind === "detail" && focusedRow && <RelaySidePanel title="请求详情" onClose={close}><RelayRequestDetails row={focusedRow} rates={rates}
      onPricing={() => setSurface({ kind: "pricing", row: focusedRow })} /></RelaySidePanel>}
    {surface?.kind === "pricing" && <RelaySidePanel title="Token 单价" onClose={close}><RelayPriceForm rows={rows} initial={focusedRow} rates={rates} onSave={saveRates} /></RelaySidePanel>}
    {surface?.kind === "stop" && <ConfirmDialog title="停止中转？" description="停止监听将中断进行中的请求。配置与历史记录会保留。"
      confirmLabel="停止中转" variant="destructive" onCancel={close} onConfirm={() => void changeService("stop")} />}
  </div>;
}

function RelayRecentRequests({ todayRows, historyRows, rates, limited, selected, onRequest, onGuide }: {
  todayRows: RelayLogEntry[]; historyRows: RelayLogEntry[]; rates: RelayRates; limited: boolean;
  selected: string | null; onRequest: (row: RelayLogEntry) => void; onGuide?: () => void;
}) {
  const [filter, setFilter] = useState({ errors: false, full: false });
  const { errors, full } = filter;
  const rows = full ? historyRows : todayRows;
  return <>
    {limited && <div className="relay-work-notice relay-inline relay-spread"><div><strong>上游限流</strong><span>最近一条模型请求收到 HTTP 429。</span></div>
      <Button size="sm" variant="outline" onClick={() => setFilter({ ...filter, errors: true })}>查看异常</Button></div>}
    <section className="relay-work-panel" aria-labelledby="relay-requests-heading">
      <header className="relay-section-head"><div><h2 id="relay-requests-heading">{full ? "完整请求" : "最近请求"}</h2><p>{full ? "最近 7 天的模型请求与 Token 预估请求。" : "选择一条记录，查看路由和 Token 明细。"}</p></div>
        <div className="relay-inline relay-wrap"><div className="relay-seg" role="group" aria-label="请求结果筛选">
          <button type="button" aria-pressed={!errors} onClick={() => setFilter({ ...filter, errors: false })}>全部</button>
          <button type="button" aria-pressed={errors} onClick={() => setFilter({ ...filter, errors: true })}>仅异常</button>
        </div><Button size="sm" variant="ghost" onClick={() => setFilter({ ...filter, full: !full })}>{full ? "返回最近请求" : "完整请求"}<Icon name={full ? "chevronLeft" : "chevronRight"} size={13} /></Button></div>
      </header>
      <RelayRequestTable key={`${full}:${errors}`} rows={errors ? rows.filter(isRelayError) : rows} rates={rates} dated={full} selected={selected} onRequest={onRequest}
        empty={<><p>{errors ? "没有符合筛选条件的异常请求。" : full ? "近 7 天没有请求记录。" : "今天还没有请求记录。"}</p>
          {!errors && onGuide && <Button size="sm" variant="outline" onClick={onGuide}>打开接入指南</Button>}</>} />
      <p className="relay-work-footnote">经 SSH 隧道接入的请求归入「回环」。</p>
    </section>
  </>;
}
