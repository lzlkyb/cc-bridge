import { useEffect, useRef, useState } from "react";
import type { RelayProbeOutcome, RelayProviderChange, RelayProviderResult, RelaySnapshot } from "../../lib/types";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { RelayUpstreamCard } from "./RelayUpstreamCard";
import "./relay-provider-settings.css";

function providerConfigs(snapshot: RelaySnapshot) {
  return snapshot.providers ?? (snapshot.provider ? [{ provider: snapshot.provider, tiers: snapshot.tiers }] : []);
}

type ChangeProvider = (change: RelayProviderChange) => Promise<RelayProviderResult>;
export type RelayProviderTests = Record<string, RelayProbeOutcome>;

function testLabel(test?: RelayProbeOutcome) {
  return test?.switchedAuth ? "需更换鉴权" : test ? (test.ok ? "测试通过" : "测试失败") : "待测试";
}

function needsSwitchConfirmation(test?: RelayProbeOutcome) {
  return test && (!test.ok || Boolean(test.switchedAuth));
}

function SwitchConfirm({ name, onCancel, onConfirm, zIndex }: { name: string; onCancel: () => void; onConfirm: () => void; zIndex?: number }) {
  return <ConfirmDialog title="仍要切换上游？" description={`「${name}」的当前配置未通过测试。切换后，新请求可能失败。`}
    confirmLabel="仍然切换" onCancel={onCancel} onConfirm={onConfirm} zIndex={zIndex} />;
}

export function RelayProviderMenu({ snapshot, disabled, onActivate, tests }: {
  snapshot: RelaySnapshot;
  disabled: boolean;
  onActivate: (id: string) => void;
  tests: RelayProviderTests;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const current = snapshot.provider;
  const configured = providerConfigs(snapshot).filter(({ provider }) => provider.configured && provider.id);
  if (!current?.configured || !configured.length) return null;
  const confirmTarget = configured.find(({ provider }) => provider.id === confirmId)?.provider;
  return <><Menu width="w-64" trigger={(open, toggle) => <Button variant="outline" size="sm" className="relay-provider-switch"
    aria-label={`切换当前上游，当前 ${current.name}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}>
    <span className="relay-provider-dot" aria-hidden="true"/><span className="truncate">{current.name}</span><Icon name="chevronDown" size={12}/>
  </Button>}>
    {(dismiss) => configured.map(({ provider, tiers }) => <MenuItem key={provider.id} label={<span className="min-w-0">
      <strong className="block truncate">{provider.name}</strong>
      <small className="block truncate text-muted-foreground">{tiers.find((tier) => tier.tier === "default")?.upstreamModel} · {testLabel(tests[provider.id!])}</small>
    </span>} active={provider.id === current.id}
      trailing={provider.id === current.id && <Icon name="check" size={14} aria-label="当前使用"/>}
      onClick={() => {
        dismiss();
        if (provider.id === current.id) return;
        if (needsSwitchConfirmation(tests[provider.id!])) setConfirmId(provider.id!);
        else onActivate(provider.id!);
      }} />)}
  </Menu>{confirmTarget && <SwitchConfirm name={confirmTarget.name} onCancel={() => setConfirmId(null)}
    onConfirm={() => { setConfirmId(null); if (!disabled) onActivate(confirmTarget.id!); }} />}</>;
}

type Confirmation = { kind: "discard" | "remove" | "switch"; run: () => void };

export function RelayProviderSettings({ snapshot, onClose, mutate, busy, tests, remember }: {
  snapshot: RelaySnapshot;
  onClose: () => void;
  mutate: ChangeProvider;
  busy: boolean;
  tests: RelayProviderTests;
  remember: (id: string, outcome: RelayProbeOutcome | null) => void;
}) {
  const activeId = snapshot.provider ? snapshot.provider.id ?? "default" : "";
  const [selected, setSelected] = useState(activeId);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const closeEditor = useRef(onClose);
  const configs = providerConfigs(snapshot);
  const entry = selected ? configs.find(({ provider }) => (provider.id ?? "default") === selected) : undefined;
  const id = entry ? selected : "";
  const active = Boolean(id && activeId === id);
  const editing = { provider: entry?.provider ?? null, tiers: entry?.tiers ?? [], profiles: snapshot.profiles };

  useEffect(() => {
    if (busy || confirmation) return;
    // Saving or switching can remove the focused button while the dialog stays open.
    const frame = window.requestAnimationFrame(() => {
      const panel = listRef.current?.closest('[role="dialog"]');
      if (panel && !panel.contains(document.activeElement)) {
        panel.querySelector<HTMLButtonElement>('.relay-provider-list button[aria-current="true"]:not(:disabled)')?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busy, confirmation, id, active]);

  const select = (next: string) => {
    setSelected(next);
    setFeedback(null);
    window.requestAnimationFrame(() => (next ? listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')
      : document.getElementById("relay-provider-name"))?.focus({ preventScroll: true }));
  };
  const change = async (action: "activate" | "remove") => {
    setFeedback(null);
    try {
      const result = await mutate({ action, id });
      if (action === "remove") {
        remember(id, null);
        select(result.snapshot.provider?.id ?? "");
        setFeedback({ text: "上游配置已删除。" });
      } else {
        setFeedback({ text: snapshot.running ? "已切换，新请求将走此上游。" : "已切换，启动中转后将使用此上游。" });
      }
      window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus({ preventScroll: true }));
    } catch (error) {
      setFeedback({ text: String(error), error: true });
    }
  };

  return <Modal open ariaLabel="上游设置" onClose={() => closeEditor.current()} animation="fade" overlayClassName="relay-provider-overlay"
    className="relay-provider-dialog modal-surface"><RelayUpstreamCard key={id} snapshot={editing} managed={{ id, active, mutate, previousTest: tests[id],
    onTest: (outcome) => remember(id, outcome),
    onSaved: (saved, outcome) => {
      remember(saved, outcome);
      select(saved);
      setFeedback({ text: "上游配置已保存。" });
    },
    layout: ({ body, save, dirty, saving }) => {
      const pending = busy || saving;
      const guard = (run: () => void) => {
        if (pending) return;
        if (dirty) setConfirmation({ kind: "discard", run });
        else run();
      };
      const close = () => guard(onClose);
      closeEditor.current = close;
      return <>
          <header className="relay-provider-head"><span className="relay-route-symbol"><Icon name="server" size={20}/></span>
            <div><h2>上游设置</h2><p>切换后，新请求走当前上游，远端配置无需更新。</p></div>
            <Button size="icon" variant="ghost" aria-label="关闭上游设置" onClick={close} disabled={pending}><Icon name="close" size={17}/></Button>
          </header>
          <div className="relay-provider-layout">
            <aside className="relay-provider-list" aria-label="上游配置列表" ref={listRef}>
              <header><h3>上游配置 <small>· {configs.length}</small></h3><Button size="sm" variant="ghost" disabled={pending}
                onClick={() => id ? guard(() => select("")) : document.getElementById("relay-provider-name")?.focus()}><Icon name="plus" size={13}/>新增</Button></header>
              <ul>{configs.map(({ provider, tiers }) => {
                const key = provider.id ?? "default";
                const isCurrent = key === activeId;
                const test = tests[key];
                const label = !provider.configured ? "待配置" : isCurrent ? "当前使用" : testLabel(test);
                return <li key={key}><button type="button" aria-current={id === key} disabled={pending} onClick={() => { if (id !== key) guard(() => select(key)); }}>
                  <span className="relay-route-symbol"><Icon name="server" size={15}/></span><span>
                    <strong title={provider.name}>{provider.name || "待配置上游"}</strong><small>{tiers.find((tier) => tier.tier === "default")?.upstreamModel || "默认模型未配置"}</small>
                    <span className="relay-work-badge" data-tone={isCurrent && provider.configured ? "ok" : test && !test.ok ? "bad" : "mute"}>{label}</span>
                  </span></button></li>;
              })}
                {!id && <li><button type="button" aria-current="true" onClick={() => document.getElementById("relay-provider-name")?.focus()}>
                  <span className="relay-route-symbol"><Icon name="plus" size={15}/></span><span><strong>新增上游</strong><small>尚未保存</small></span></button></li>}
              </ul>
            </aside>
            <div className="relay-provider-scroll">{body}</div>
          </div>
          <footer className="relay-provider-foot">
            <p role={feedback?.error ? "alert" : "status"} data-tone={feedback?.error ? "bad" : feedback ? "ok" : dirty ? "warn" : undefined}>
              {feedback?.error || (!dirty && feedback) ? feedback.text : dirty ? "有尚未保存的改动。" : active ? "新请求将使用此上游。" : id || snapshot.provider?.configured ? "保存的配置可随时切换。" : "首次保存后即可接入客户端。"}
            </p>
            <div className="relay-inline relay-wrap">
              {!active && id && !dirty && <Button size="sm" className="relay-provider-remove" variant="ghost" disabled={pending}
                onClick={() => setConfirmation({ kind: "remove", run: () => void change("remove") })}><Icon name="trash" size={14}/>删除配置</Button>}
              <Button size="sm" variant="outline" onClick={close} disabled={pending}>关闭</Button>
              {(dirty || !id) && save}
              {!active && id && !dirty && entry?.provider.configured && <Button size="sm" disabled={pending} onClick={() => {
                const run = () => void change("activate");
                if (needsSwitchConfirmation(tests[id])) setConfirmation({ kind: "switch", run });
                else run();
              }}>切换到此上游</Button>}
            </div>
          </footer>
        {confirmation?.kind === "switch" && <SwitchConfirm name={entry?.provider.name ?? "上游"} zIndex={1010}
          onCancel={() => setConfirmation(null)} onConfirm={() => { setConfirmation(null); confirmation.run(); }} />}
        {confirmation && confirmation.kind !== "switch" && <ConfirmDialog zIndex={1010} variant="destructive"
          title={confirmation.kind === "remove" ? "删除这套上游？" : "放弃未保存的修改？"}
          description={confirmation.kind === "remove" ? `「${entry?.provider.name}」及保存的密钥将被移除。` : "本次编辑会丢失，已保存的配置会保留。"}
          confirmLabel={confirmation.kind === "remove" ? "删除配置" : "放弃修改"} onCancel={() => setConfirmation(null)}
          onConfirm={() => { setConfirmation(null); confirmation.run(); }} />}
      </>;
    },
  }} /></Modal>;
}
