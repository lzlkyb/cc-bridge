import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { SavedHint } from "../ui/SavedHint";
import type { RelayProbeOutcome, RelaySnapshot } from "../../lib/types";
import { useRelayDraft, type RelayDraft } from "../../hooks/useRelayDraft";
import { RelayAdvancedSettings } from "./RelayAdvancedSettings";
import { formatMs } from "../../lib/relayFormat";

/** 与后端 `Option<u32>` 对齐的上限。
 *
 *  超限时 serde 会**整条 patch** 拒绝，前端只看到一句天书错误，且不改就永远
 *  存不进去。所以在输入侧就限长 + 失焦拦住，给一句人能看懂的话。 */
const MAX_TOKENS_U32 = 4_294_967_295;

type ManagedEditor = NonNullable<Parameters<typeof useRelayDraft>[2]> & {
  active: boolean;
  previousTest?: RelayProbeOutcome;
  onTest: (result: RelayProbeOutcome) => void;
  layout: (content: { body: ReactNode; save: ReactNode; dirty: boolean; saving: boolean }) => ReactNode;
};

export function RelayUpstreamCard({
  snapshot,
  onChanged,
  managed,
}: {
  snapshot: Pick<RelaySnapshot, "provider" | "tiers" | "profiles">;
  onChanged?: () => void;
  managed?: ManagedEditor;
}) {
  const explicit = Boolean(managed);
  const form = useRelayDraft(snapshot, onChanged, managed);
  const { draft, setField, setError, save, dirty, saving, error, savedAt, probe, probing, probeResult, models, listing, fetchModels } = form;
  const [replacingKey, setReplacingKey] = useState(false);
  const hasKey = snapshot.provider?.hasApiKey ?? false;
  const originChanged = hasKey && upstreamOrigin(draft.baseUrl) !== upstreamOrigin(snapshot.provider?.baseUrl ?? "");
  const showKey = replacingKey || !hasKey || originChanged;
  const configured = snapshot.provider?.configured ?? false;
  const ready = Boolean(draft.baseUrl.trim() && draft.model.trim() && (draft.apiKey.trim() || (hasKey && !originChanged)));

  // ── 厂商画像 ──────────────────────────────────────────────────────
  // 下拉的 value 是「用户显式选的 id」，空串表示跟随地址自动识别；显示用的
  // 名字取自后端解析结果，两件事分开，才不会把推断值固化成用户选择。
  const profiles = snapshot.profiles ?? [];
  const resolvedId = snapshot.provider?.resolvedProfileId ?? "custom";
  const activeProfile = profiles.find((p) => p.id === (draft.profileId || resolvedId));
  const profileModels = activeProfile?.models ?? [];
  // 预设候选 + 上游真实列表，去重。探测结果排前面：它是这次会话的事实，
  // 预设只是「探测失败时别让输入框空着」。
  const modelOptions = Array.from(new Set([...models, ...profileModels]));
  const modelUnknown = models.length > 0 && draft.model.trim() !== "" && !models.includes(draft.model.trim());
  const modelListId = explicit ? "relay-model-options-explicit" : "relay-model-options";
  // 上次由「选厂商」写进去的地址。只有地址还是它（或为空）时才允许下一次
  // 选择覆盖——否则会把用户手打的地址冲掉。
  const prefilledHost = useRef("");

  const chooseProfile = (id: string) => {
    const next = profiles.find((p) => p.id === id);
    const mayFill = draft.baseUrl.trim() === "" || draft.baseUrl === prefilledHost.current;
    const update: Partial<RelayDraft> = { profileId: id };
    if (next?.defaultHost && mayFill) {
      const url = `https://${next.defaultHost}`;
      prefilledHost.current = url;
      update.baseUrl = url;
    }
    // 选了厂商就顺手把鉴权头摆到它常用的那种：两者不匹配的报错是 401，
    // 而 401 里看不出「头用错了」。
    if (next) update.authStyle = next.auth;
    setField(update);
  };

  // 「已保存」只亮 1.6 秒。常驻会更糟：那两个字一旦住下来，就再也分不清
  // 「这次改动存进去了」和「上次存的那次」——而这一页恰恰没有保存按钮。
  const [flashSaved, setFlashSaved] = useState(false);
  useEffect(() => {
    if (savedAt == null) return;
    setFlashSaved(true);
    const timer = setTimeout(() => setFlashSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const apply = (override?: Partial<RelayDraft>) => {
    if ((!dirty && !override) || saving || probing || listing || !ready) return;
    if (draft.maxTokens !== "" && Number(draft.maxTokens) > MAX_TOKENS_U32) {
      setError("max_tokens 不能超过 4294967295（后端整数上限）。");
      return;
    }
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      setError("请输入有效的 HTTP 或 HTTPS 上游地址。");
      return;
    }
    void save(override).then((result) => { if (result?.ok) setReplacingKey(false); });
  };
  const commit = (event: FocusEvent<HTMLElement>) => {
    if (explicit || event.relatedTarget?.matches("[data-relay-autosave]")) return;
    apply();
  };

  const tail = probeResult
      ? probeResult.ok
        ? probeResult.switchedAuth ? `需更换鉴权 · ${probeResult.switchedAuth}` : `上次测试通过 · ${formatMs(probeResult.firstByteMs)}`
        : probeResult.status ? `上游 ${probeResult.status}` : "无法连接上游"
      : configured
        ? "已配置"
        : "待填写";

  const test = probeResult ?? (!dirty && !probing && !error ? managed?.previousTest : undefined);
  const alternateAuth = test?.switchedAuth === "bearer" || test?.switchedAuth === "x-api-key" ? test.switchedAuth : null;
  const body = (
    <fieldset className="relay-upstream-editor" disabled={saving || listing} data-explicit={explicit || undefined}>
      {managed ? <div className="relay-provider-editor-heading"><div><h3>{snapshot.provider?.name || "新增上游"}</h3>
        <p>{snapshot.provider?.baseUrl ? newHost(snapshot.provider.baseUrl) : "选择供应商或填写兼容服务的地址。"}</p></div>
        <span className="relay-work-badge" data-tone={managed.active ? "ok" : "mute"}>{managed.active ? "当前使用" : managed.id ? "备用上游" : "新配置"}</span></div> : <><div className="bento-eyebrow relay-card-head">
        <Icon name="server" size={12} />
        <span className="grow">配置上游供应商</span>
        {flashSaved && <SavedHint>已保存</SavedHint>}
        <span className="relay-tail" data-tone={probeResult && (!probeResult.ok || probeResult.switchedAuth) ? "bad" : undefined}>
          {tail}
        </span>
      </div>
      <p className="relay-work-muted">从上游控制台取得以下三项。填齐后，离开输入框即自动保存。</p></>}

      <div className="relay-fields">
        {managed && <div className="relay-field"><label htmlFor="relay-provider-name">配置名称</label>
          <input id="relay-provider-name" className="tinp" value={draft.name} maxLength={48} autoComplete="off"
            placeholder="例如：团队上游" onChange={(event) => setField({ name: event.target.value })} /></div>}
        <div className="relay-field">
          <label htmlFor="relay-profile">供应商</label>
          <select
            id="relay-profile"
            className="tinp"
            value={draft.profileId}
            onChange={(event) => chooseProfile(event.target.value)}
            onBlur={commit}
          >
            <option value="">自动识别（{snapshot.provider?.profileLabel ?? "自定义"}）</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.dialect === "openai" ? " · 需协议转换" : ""}
              </option>
            ))}
          </select>
          <span className="relay-chip-note">
            {activeProfile?.note || "选厂商会自动填地址前缀，也可以直接手填。"}
          </span>
        </div>

        <div className="relay-field">
          <label htmlFor="relay-base-url">上游地址</label>
          <input
            id="relay-base-url"
            className="tinp mono"
            value={draft.baseUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://your-upstream.example.com"
            onChange={(e) => setField({ baseUrl: e.target.value })}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>

        <div className="relay-field">
          <label htmlFor={showKey ? "relay-api-key" : undefined}>API 密钥</label>
          {showKey ? (
            <div className="relay-inline"><input
              id="relay-api-key"
              className="tinp mono"
              type="password"
              value={draft.apiKey}
              spellCheck={false}
              autoComplete="off"
              autoFocus={replacingKey}
              placeholder={originChanged ? "请填写新地址对应的密钥" : "粘贴 API 密钥"}
              onChange={(e) => setField({ apiKey: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onKeyDownCapture={(e) => {
                if (e.key === "Escape" && replacingKey && !e.nativeEvent.isComposing) {
                  e.stopPropagation();
                  // 「取消」必须把草稿里的密钥一起丢掉：只关输入框的话，
                  // 之后应用其他字段时会把这枚被取消的密钥一起保存。
                  setField({ apiKey: "" });
                  setReplacingKey(false);
                }
              }}
            />{replacingKey && !originChanged && <button type="button" className="relay-mini-btn" onClick={() => { setField({ apiKey: "" }); setReplacingKey(false); }}>取消更换</button>}</div>
          ) : (
            <div className="relay-field row">
              <code className="relay-mask">{snapshot?.provider?.hasApiKey ? snapshot.provider.apiKeyMasked : "未填"}</code>
              <button type="button" className="relay-mini-btn" onClick={() => setReplacingKey(true)}>
                更换
              </button>
            </div>
          )}
        </div>

        <div className="relay-field">
          <label htmlFor="relay-model">默认模型</label>
          <div className="relay-inline">
            <input
              id="relay-model"
              className="tinp mono grow"
              value={draft.model}
              spellCheck={false}
              autoComplete="off"
              list={modelOptions.length > 0 ? modelListId : undefined}
              placeholder={modelOptions[0] ? `如 ${modelOptions[0]}` : "上游控制台里的模型名"}
              onChange={(e) => setField({ model: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <button
              type="button"
              className="relay-mini-btn"
              disabled={listing || !draft.baseUrl.trim() || !(draft.apiKey.trim() || (hasKey && !originChanged))}
              onClick={() => void fetchModels()}
            >
              {listing ? "获取中…" : "获取列表"}
            </button>
          </div>
          {modelOptions.length > 0 && (
            <datalist id={modelListId}>
              {modelOptions.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
          {modelUnknown && (
            <span className="relay-chip-note" data-tone="warn">
              这个名字不在上游返回的列表里，仍可保存——有些网关的列表不含全部可调模型。
            </span>
          )}
        </div>
      </div>

      {managed && <div className="relay-provider-probe" data-tone={test ? (alternateAuth ? "warn" : test.ok ? "ok" : "bad") : undefined}>
        <div role="status"><strong>{probing ? "正在测试上游" : alternateAuth ? `换用 ${alternateAuth === "bearer" ? "Bearer" : alternateAuth} 后通过` : test ? (test.ok ? "连接测试通过" : "上游请求失败") : "连接测试"}</strong>
          <p>{probing ? "等待上游响应…" : test ? (test.ok ? `收到上游响应 · ${formatMs(test.firstByteMs ?? test.totalMs)}` : probeFailure(test.status)) : "使用当前表单中的地址、密钥与默认模型。"}</p>
          {alternateAuth && <p>采用该鉴权方式重新测试，确认后保存配置。</p>}
          {test && !test.ok && test.errorHead && <details><summary>查看响应详情</summary><pre>{test.errorHead}</pre></details>}</div>
        <Button size="sm" variant="outline" isLoading={probing} loadingText="正在测试" disabled={!ready || saving}
          onClick={() => {
            if (alternateAuth) setField({ authStyle: alternateAuth });
            void probe(alternateAuth ?? undefined).then((outcome) => { if (outcome && !dirty && !alternateAuth) managed.onTest(outcome); });
          }}>{alternateAuth ? "应用到表单并重新测试" : test ? "重新测试" : "测试上游"}</Button>
      </div>}
      <RelayAdvancedSettings
        draft={draft}
        setField={setField}
        apply={apply}
        commit={commit}
        explicit={explicit}
        setError={setError}
      />
      {!managed && <><div className="relay-inline relay-wrap">
        <button type="button" className="relay-mini-btn" disabled={!ready || probing || saving} onClick={() => void probe()}>
          <Icon name={probing ? "spinner" : "activity"} size={13} className={probing ? "animate-spin" : ""} />{probing ? "正在测试" : "测试上游"}
        </button>
        {error && <button type="button" className="relay-mini-btn relay-apply-button" onClick={() => apply()} disabled={!dirty || !ready || saving}>
          重试保存
        </button>}
      </div>
      {probeResult && !probeResult.ok && <div className="relay-probe-fail" role="alert"><b>{probeFailure(probeResult.status)}</b><pre>{probeResult.errorHead ?? "没有响应体"}</pre></div>}
      {probeResult?.switchedAuth && <div className="relay-probe-ok">测试使用 <code>{probeResult.switchedAuth}</code> 通过，可在高级设置中切换鉴权方式。</div>}</>}
      {error && <div className="relay-inline-error" role="alert">{error}</div>}
      {saving && <div className="relay-inline-hint" role="status">正在保存…</div>}
    </fieldset>
  );
  if (!managed) return body;
  const saveButton = <Button size="sm" onClick={() => apply()} isLoading={saving} loadingText="正在保存"
    disabled={!ready || !draft.name.trim() || probing || listing}>{!managed.id ? "保存上游" : managed.active ? "保存并应用" : "保存配置"}</Button>;
  return managed.layout({ body, save: saveButton, dirty, saving });
}

function upstreamOrigin(url: string) { try { return new URL(url.trim()).origin; } catch { return ""; } }
function newHost(url: string) { try { return new URL(url).host; } catch { return ""; } }

function probeFailure(status: number) {
  if (status === 0) return "无法连接上游，请检查网络或上游地址后重试。";
  if (status === 401 || status === 403) return `HTTP ${status} · 检查 API 密钥、鉴权方式与访问权限。`;
  if (status === 404) return "HTTP 404 · 检查上游地址和模型名称。";
  if (status === 429) return "HTTP 429 · 检查上游配额或稍后重试。";
  return `HTTP ${status} · 请检查上游状态或查看响应详情。`;
}
