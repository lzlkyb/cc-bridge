import { useEffect, useRef, useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus, TlsStatus, ConfigSaveResult } from "../../../lib/types";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { Input } from "../../ui/input";
import { ToggleRow } from "../../ui/ToggleRow";
import { useToast } from "../../ui/toast";

/** 证书到期日：epoch 秒 → 本地 YYYY-MM-DD。 */
function fmtExpiry(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 「HTTPS 远程访问」开启后的子面板（P1-5 设计稿）：
 * 接入 URL + 证书指纹卡 + 401 封禁设置 + 自签兼容性提示。
 *
 * 数据来自父组件传入的 `tls`（get_tls_status）；四项配置的变更都在保存后
 * restart_mcp_server——TLS 开关决定监听协议、封禁策略在 restart 时同步进 BanState。
 */
export function RemoteTlsPanel({
  status,
  tls,
  onSaved,
  onRefetch,
}: {
  status?: StaticStatus;
  tls: TlsStatus;
  onSaved: () => void;
  onRefetch: () => void;
}) {
  const { toast } = useToast();
  const [regenerating, setRegenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // 封禁数字：仅在首次拿到服务端值时回填；之后用户偏离值不被轮询冲掉。
  const [threshold, setThreshold] = useState(String(tls.banThreshold));
  const [windowMin, setWindowMin] = useState(String(tls.banWindowMin));
  const syncedRef = useRef({ threshold: tls.banThreshold, window: tls.banWindowMin });
  useEffect(() => {
    const previous = syncedRef.current;
    setThreshold(cur => cur === String(previous.threshold) ? String(tls.banThreshold) : cur);
    setWindowMin(cur => cur === String(previous.window) ? String(tls.banWindowMin) : cur);
    syncedRef.current = { threshold: tls.banThreshold, window: tls.banWindowMin };
  }, [tls.banThreshold, tls.banWindowMin]);
  const numbersValid = threshold.trim() !== "" && windowMin.trim() !== "" &&
    Number.isInteger(Number(threshold)) && Number(threshold) >= 1 && Number(threshold) <= 1000 &&
    Number.isInteger(Number(windowMin)) && Number(windowMin) >= 1 && Number(windowMin) <= 1440;
  const numbersDirty = Number(threshold) !== tls.banThreshold || Number(windowMin) !== tls.banWindowMin;

  const ip = status?.lastSelectedIp ?? status?.lanIps?.[0] ?? "127.0.0.1";
  const url = `https://${ip}:${status?.port ?? 7823}/mcp`;

  const handleCopy = async () => {
    // 复制失败必须如实说（审查 U8）：原来没 catch，写剪贴板被拒时仍提示「已复制」。
    try {
      await navigator.clipboard.writeText(url);
      toast("接入地址已复制", "success");
    } catch (e) {
      toast(`复制失败：${String(e)}`, "error");
    }
  };

  // 保存 + 重启监听。TLS 开关 / 封禁策略都经 restart_server 生效，统一走这条。
  const saveAndRestart = async (patch: Record<string, unknown>, okMsg: string) => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    let saved = false;
    try {
      await invoke<ConfigSaveResult>("save_config", { patch });
      saved = true;
      await invoke("restart_mcp_server");
      toast(okMsg, "success");
      onSaved();
      onRefetch();
    } catch (e) {
      const message = saved ? `配置已保存，但重启服务失败：${e}` : `保存失败：${e}`;
      setError(message);
      toast(message, "error");
      if (saved) onSaved();
    } finally {
      setSaving(false);
    }
  };

  const handleRegen = async () => {
    setRegenerating(true);
    try {
      await invoke("regen_tls_cert");
      onRefetch();
      toast("证书已重新生成，指纹已更新", "success");
    } catch (e) {
      toast(`重新生成失败：${e}`, "error");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="mb-3 ml-1 mr-1 mt-1 space-y-3 rounded-xl border bg-muted/50 p-3">
      {/* 接入地址：AI 工具里粘的就是这个 */}
      <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold text-primary"
          title={url}
        >
          {url}
        </span>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[10.5px]" onClick={handleCopy}>
          <Icon name="copy" size={12} />
          复制
        </Button>
      </div>

      {/* 指纹卡：hover 显全量 64 位；重新生成 = 换指纹 */}
      <div className="flex items-center gap-2.5 rounded-lg border border-dashed bg-background px-2.5 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <Icon name="lock" size={13} className="text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            证书指纹 SHA-256
          </div>
          <div
            className="cursor-help font-mono text-[11.5px] font-semibold"
            title={tls.fingerprintSha256}
          >
            {tls.fingerprintShort}…
          </div>
          <div className="truncate text-[11px] text-muted-foreground" title={tls.sans.join(", ")}>
            到期 {fmtExpiry(tls.notAfterEpoch)} · SAN: {tls.sans.join(", ")}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-[10.5px]"
          onClick={handleRegen}
          isLoading={regenerating}
          loadingText="生成中"
        >
          <Icon name="refresh" size={12} />
          重新生成
        </Button>
      </div>

      {/* 401 封禁（防爆破）。仅 0.0.0.0 时后端实际执行，这里照实标注。 */}
      <div>
        <div className="mb-1 mt-2 text-[10.5px] font-bold uppercase tracking-widest text-muted-foreground">
          401 封禁（防爆破）
        </div>
        <ToggleRow
          id="toggle-remote-ban"
          label="连续鉴权失败封禁 IP"
          sub={tls.boundToAll ? undefined : "当前未绑定 0.0.0.0，封禁不生效"}
          info="连续 401 达阈值后该 IP 在窗口内直接 429；认证成功即清零，重启后清零。仅监听 0.0.0.0 时后端实际执行封禁。"
          checked={tls.banEnabled}
          disabled={saving}
          pending={saving}
          onChange={(v) => saveAndRestart({ remoteBanEnabled: v }, v ? "封禁已开启" : "封禁已关闭")}
        />
        <div className="flex items-center justify-between py-2">
          <label htmlFor="remote-ban-threshold" className="text-xs font-semibold">封禁阈值（连续 401 次数）</label>
          <Input
            id="remote-ban-threshold"
            type="number"
            min={1}
            max={1000}
            value={threshold}
            disabled={saving || !tls.banEnabled}
            aria-describedby="remote-ban-help"
            onChange={(e) => setThreshold(e.target.value)}
            className="w-16 px-1 text-center font-mono text-xs font-bold tabular-nums"
          />
        </div>
        <div className="flex items-center justify-between py-2">
          <label htmlFor="remote-ban-window" className="text-xs font-semibold">封禁窗口（分钟）</label>
          <Input
            id="remote-ban-window"
            type="number"
            min={1}
            max={1440}
            value={windowMin}
            disabled={saving || !tls.banEnabled}
            aria-describedby="remote-ban-help"
            onChange={(e) => setWindowMin(e.target.value)}
            className="w-16 px-1 text-center font-mono text-xs font-bold tabular-nums"
          />
        </div>
        <p id="remote-ban-help" className="mb-2 text-xs text-muted-foreground">阈值 1–1000 次，窗口 1–1440 分钟。应用将重启服务，客户端会短暂断开。</p>
        <Button size="sm" disabled={!tls.banEnabled || !numbersValid || !numbersDirty || saving} isLoading={saving} loadingText="应用中…" onClick={() => void saveAndRestart({ remoteBanThreshold: Number(threshold), remoteBanWindowMin: Number(windowMin) }, "封禁策略已应用，服务已重启")}>应用封禁策略</Button>
        {!numbersValid && <p role="alert" className="mt-2 text-xs text-destructive-ink">请按范围输入整数。</p>}
        {error && <p role="alert" className="mt-2 text-xs text-destructive-ink">{error}</p>}
      </div>

      {/* 自签兼容性口径：不打包票，指路反代文档 */}
      <p className="rounded-lg bg-warning/8 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        <b className="text-warning-ink">自签证书兼容性</b>
        ：Claude Code 可配置信任（见接入向导）；WorkBuddy / Codex 的支持度以实测矩阵为准。有域名时优先用反向代理 +
        Let&apos;s Encrypt（全工具无感信任），见 <code>docs/reverse-proxy.md</code>。
      </p>
    </div>
  );
}
