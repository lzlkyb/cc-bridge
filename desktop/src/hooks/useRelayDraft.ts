/**
 * 中转页的表单草稿：三格必填 + 高级三项。
 *
 * 🔴 **这一页没有「保存」按钮**，这是刻意的（§4.9.4 的接触点预算：默认路径只能有 6 个）。
 * 提交时机是**失焦 / 下拉收起 / 开关点击**，成功后在卡头给一个「已保存」小提示。
 * 加一颗保存按钮会让默认路径变成 7 个接触点，也意味着存在「改了没点保存就以为存了」
 * 的中间态——而那正是设置页当初把「保存并重启」写进按钮文案的原因。
 *
 * 🔴 密钥的「空串 = 不改」是后端的约定（`relay_save` 里 `-` 才是清空）。所以草稿里
 * `apiKey` 为空**不代表**用户清空了密钥，只代表「这次没换」。界面不提供清空入口。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import { toast } from "../components/ui/toast";
import type { RelayProbeOutcome, RelayProviderChange, RelayProviderResult, RelaySaveResult, RelaySnapshot } from "../lib/types";
import { useModelCatalog } from "./useModelCatalog";

export type RelayAuthStyle = "x-api-key" | "bearer";
/** 工具 schema `\0` 归一化的三态。`auto` = 跟随厂商画像。 */
export type RelayPatterns = "auto" | "on" | "off";

export interface RelayDraft {
  name: string;
  baseUrl: string;
  /** 空 = 这次没换密钥（不是清空）。 */
  apiKey: string;
  model: string;
  haiku: string;
  opus: string;
  authStyle: RelayAuthStyle;
  /** 厂商画像 id。空串 = 跟随地址自动识别。 */
  profileId: string;
  patterns: RelayPatterns;
  /** 字符串形态：空串 = 不压。输入框不能是 number，否则删空会跳成 0。 */
  maxTokens: string;
  fold: boolean;
}

const EMPTY: RelayDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  haiku: "",
  opus: "",
  authStyle: "x-api-key",
  profileId: "",
  patterns: "auto",
  maxTokens: "",
  fold: true,
};

function fromSnapshot(snapshot: Pick<RelaySnapshot, "provider" | "tiers"> | undefined): RelayDraft {
  const provider = snapshot?.provider;
  const model = (tier: string) =>
    snapshot?.tiers.find((t) => t.tier === tier)?.upstreamModel ?? "";
  return {
    name: provider?.name ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    model: model("default"),
    haiku: model("haiku"),
    opus: model("opus"),
    authStyle: provider?.authStyle === "bearer" ? "bearer" : "x-api-key",
    profileId: provider?.profileId ?? "",
    patterns:
      provider?.normalizeToolPatterns === true
        ? "on"
        : provider?.normalizeToolPatterns === false
          ? "off"
          : "auto",
    maxTokens: provider?.maxTokensLimit ? String(provider.maxTokensLimit) : "",
    fold: provider?.foldToolBlocks ?? true,
  };
}

/** 比对用的指纹。**排除 apiKey**：它一次性的，不该让「跟随服务端」失效。 */
function fingerprint(draft: RelayDraft): string {
  return JSON.stringify({ ...draft, apiKey: "" });
}

interface ManagedDraft {
  id: string;
  mutate: (change: RelayProviderChange) => Promise<RelayProviderResult>;
  onSaved: (id: string, outcome: RelayProbeOutcome | null) => void;
}

export function useRelayDraft(snapshot: Pick<RelaySnapshot, "provider" | "tiers"> | undefined, onSaved?: () => void, managed?: ManagedDraft) {
  const [draft, setDraft] = useState<RelayDraft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<RelayProbeOutcome | null>(null);
  // 模型列表有自己的生命周期（点一次取一次），放在独立 hook 里。
  const { models, listing, fetchModels, resetCatalog } = useModelCatalog({
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    model: draft.model,
    authStyle: draft.authStyle,
    profileId: draft.profileId,
    providerId: managed?.id,
    onError: setError,
  });

  // 「跟随服务端」的口径与设置页端口行一致：只有当前输入**仍然等于上一份服务端值**
  // （即用户没改过）时才跟随；用户正在填的值不会被 2 秒轮询冲掉。
  const lastServer = useRef<string>("");
  // 🔴 首次回填门。重挂载时（页签切走再切回）React Query 的 gcTime 缓存会让
  // **首渲染就带上旧快照**——`snapshot` 一进来就是 defined，不存在「先 undefined
  // 再到达」的间隙。没有这个门，`lastServer.current` 初始 "" 与空表单指纹不相等，
  // 回填分支永不执行 ⇒ 表单停在空白态；而 `dirty` 恒真又会让失焦即存把空值
  // 写回后端（曾把已保存的上游地址/模型/分档/authStyle/maxTokens 清空）。
  const hydrated = useRef(false);
  // 在线保存计数：并发保存时 `saving` 要保持到最后一发回来（见 save 的注释）。
  const inflight = useRef(0);
  const probeRevision = useRef(0);
  useEffect(() => {
    const next = fromSnapshot(snapshot);
    if (!hydrated.current) {
      // 首次（含从缓存快照重挂载）：无条件回填一次，之后才进入「跟随」模式。
      hydrated.current = true;
      lastServer.current = fingerprint(next);
      setDraft((cur) => ({ ...next, apiKey: cur.apiKey }));
      return;
    }
    const previous = lastServer.current;
    lastServer.current = fingerprint(next);
    setDraft((cur) => (fingerprint(cur) === previous ? { ...next, apiKey: cur.apiKey } : cur));
  }, [snapshot]);

  const baseline = fromSnapshot(snapshot);
  const dirty = fingerprint(draft) !== fingerprint(baseline) || draft.apiKey !== "";

  const setField = useCallback((patch: Partial<RelayDraft>) => {
    setError("");
    if ("baseUrl" in patch || "apiKey" in patch || "authStyle" in patch || "profileId" in patch) resetCatalog();
    if ("baseUrl" in patch || "apiKey" in patch || "model" in patch || "authStyle" in patch || "profileId" in patch) {
      probeRevision.current += 1;
      setProbeResult(null);
    }
    setDraft((cur) => ({ ...cur, ...patch }));
  }, [resetCatalog]);

  /**
   * 提交。调用方在失焦 / 下拉收起 / 开关点击时直接调用，不需要先判断 dirty。
   *
   * `override` 用于「点下去就要存」的控件（鉴权方式、折叠开关）：那一刻 React 的
   * state 还没落地，直接读 `draft` 会提交上一次的值。把新值一起传进来，
   * 比等一个 effect 再存可靠。
   *
   * 🔴 **不做「上一次还没回来就丢弃这一次」**：那会让界面停在新值、后端停在旧值，
   * 而 2 秒后的快照又不敢覆盖（用户"改过"），两边就一直错着。改成计数在线请求，
   * 两个请求按序写库、后写者赢 —— 界面显示的正好就是最后一次点击。
   */
  const save = useCallback(
    async (override?: Partial<RelayDraft>): Promise<RelaySaveResult | null> => {
      const next: RelayDraft = { ...draft, ...override };
      const patch: Record<string, unknown> = {
        baseUrl: next.baseUrl.trim(),
        model: next.model.trim(),
        haiku: next.haiku.trim(),
        opus: next.opus.trim(),
        authStyle: next.authStyle,
        // 空串 = 回到自动识别（后端清空 profile_id）。
        profileId: next.profileId,
        normalizeToolPatterns: next.patterns,
        // 0 是「不压」的哨兵；清空输入框就是取消上限。
        maxTokensLimit: next.maxTokens.trim() === "" ? 0 : Number(next.maxTokens),
        foldToolBlocks: next.fold,
      };
      // 只有真的填了新密钥才带上这一项：空串在后端表示「不改」，
      // 但连传都不传更清楚——省得以后有人以为空串是清空。
      if (next.apiKey.trim() !== "") patch.apiKey = next.apiKey.trim();

      inflight.current += 1;
      setSaving(true);
      setError("");
      try {
        if (managed) {
          const result = await managed.mutate({ action: "save", id: managed.id || undefined, name: next.name, patch });
          const saved = fromSnapshot(result.snapshot.providers?.find(({ provider }) => provider.id === result.id));
          lastServer.current = fingerprint(saved);
          setDraft(saved);
          managed.onSaved(result.id, probeResult);
          return { ok: true, configured: true, missing: null, restartRequired: false, warnings: [] };
        }
        const result = await invoke<RelaySaveResult>("relay_save", { patch });
        // 密钥输完就该从内存里消失。只在「这一发之后用户没再动过密钥框」时清，
        // 否则会把用户刚粘贴的下一个密钥抹掉。
        setDraft((cur) => (cur.apiKey === next.apiKey ? { ...cur, apiKey: "" } : cur));
        setSavedAt(Date.now());
        onSaved?.();
        for (const warning of result.warnings) toast(warning, "warning");
        if (!result.configured) {
          const field =
            result.missing === "apiKey" ? "密钥" : result.missing === "model" ? "模型" : "上游地址";
          setError(`还差${field}，填完就能用了。`);
        }
        return result;
      } catch (e) {
        const message = String(e);
        setError(message);
        toast(`保存失败：${message}`, "error");
        return null;
      } finally {
        inflight.current -= 1;
        if (inflight.current === 0) setSaving(false);
      }
    },
    [draft, managed, onSaved, probeResult],
  );

  /** 用当前表单值打一发最小请求。失败原因原样带回来，不转述。 */
  const probe = useCallback(async (authOverride?: RelayAuthStyle): Promise<RelayProbeOutcome | null> => {
    if (probing) return null;
    const revision = probeRevision.current;
    setProbing(true);
    setError("");
    setProbeResult(null);
    try {
      const outcome = await invoke<RelayProbeOutcome>("relay_test_upstream", {
        ...(managed ? { providerId: managed.id } : {}),
        draft: {
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey.trim(),
          model: draft.model.trim(),
          authStyle: authOverride ?? draft.authStyle,
          profileId: draft.profileId,
        },
      });
      if (revision !== probeRevision.current) return null;
      setProbeResult(outcome);
      return outcome;
    } catch (e) {
      if (revision !== probeRevision.current) return null;
      const failure = { status: 0, ok: false, firstByteMs: null, totalMs: 0, errorHead: String(e), switchedAuth: null };
      setProbeResult(failure);
      return failure;
    } finally {
      setProbing(false);
    }
  }, [draft.apiKey, draft.authStyle, draft.baseUrl, draft.model, draft.profileId, managed, probing]);

  return {
    draft, setField, dirty, saving, error, setError, savedAt, save,
    probe, probing, probeResult,
    models, listing, fetchModels,
  };
}
