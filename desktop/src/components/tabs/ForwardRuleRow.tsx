import { Icon } from "../ui/icon";
import { SettingsChoice } from "../ui/SettingsChoice";
import { toast } from "../ui/toast";
import { exposesListen, sameForward } from "../../lib/sshTunnelStore";
import type { ForwardRule, TunnelStatus } from "../../lib/types";

/** c2s = 本机 → 服务器（-L / -D），s2c = 服务器 → 本机（-R）。方向由所在的表决定，行内不再选方向。 */
export type ForwardSide = "c2s" | "s2c";

export const FORWARD_GRID: Record<ForwardSide, string> = {
  c2s: "grid grid-cols-[24px_minmax(96px,1fr)_76px_112px_minmax(110px,1.2fr)_76px_minmax(72px,0.8fr)_120px_28px] items-center gap-2",
  s2c: "grid grid-cols-[24px_minmax(96px,1fr)_84px_minmax(110px,1.2fr)_76px_minmax(72px,0.8fr)_120px_28px] items-center gap-2",
};

const cell = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const KIND_OPTIONS = [{ value: "local", label: "转发" }, { value: "dynamic", label: "SOCKS5" }];

interface Badge {
  text: string;
  tone: string;
  title?: string;
  /** 监听中时「该连哪个地址」，点状态可复制。 */
  copy?: string;
  where?: string;
}

/** 监听在 0.0.0.0 一类通配地址时，本机/服务器自己去连用 127.0.0.1。 */
function usageAddr(rule: ForwardRule, boundPort: number | null): string {
  const host = ["0.0.0.0", "*", "::", ""].includes(rule.listenHost) ? "127.0.0.1" : rule.listenHost;
  return `${host.includes(":") ? `[${host}]` : host}:${boundPort ?? rule.listenPort}`;
}

/** 运行态对这一行草稿的说法。running=undefined 表示转发没开。 */
function ruleBadge(rule: ForwardRule, running: TunnelStatus | undefined): Badge {
  if (!running) return { text: rule.enabled ? "未开启" : "已停用", tone: "text-muted-foreground" };
  const live = running.rules.find((x) => x.rule.id === rule.id);
  if (!rule.enabled) return live ? { text: "待移除", tone: "text-amber-600" } : { text: "已停用", tone: "text-muted-foreground" };
  if (!live || !sameForward(rule, live.rule)) return { text: "待应用", tone: "text-amber-600", title: "改动还没生效，点「保存并应用」" };
  if (live.state === "failed") return { text: "失败", tone: "text-destructive-ink", title: live.message ?? undefined };
  if (live.state === "pending") return { text: "等待中", tone: "text-muted-foreground" };
  return {
    text: live.boundPort ? `监听中 :${live.boundPort}` : "监听中",
    tone: "text-green-600",
    copy: usageAddr(rule, live.boundPort),
    where: rule.kind === "remote" ? "在服务器上连接" : rule.kind === "dynamic" ? "SOCKS5 代理地址" : "连接",
  };
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${text}`, "success");
  } catch {
    toast("复制失败，请检查剪贴板权限", "error");
  }
}

function PortInput({ value, onChange, placeholder, label }: { value: number; onChange: (v: number) => void; placeholder: string; label: string }) {
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      className={`${cell} tabular-nums`}
      value={value || ""}
      placeholder={placeholder}
      onChange={(e) => onChange(Math.min(Number(e.target.value.replace(/\D/g, "")), 65535))}
    />
  );
}

export function ForwardRuleRow({
  side,
  rule,
  running,
  onChange,
  onRemove,
}: {
  side: ForwardSide;
  rule: ForwardRule;
  running: TunnelStatus | undefined;
  onChange: (patch: Partial<ForwardRule>) => void;
  onRemove: () => void;
}) {
  const badge = ruleBadge(rule, running);
  const c2s = side === "c2s";
  const targetHint = c2s ? "如 127.0.0.1（服务器自己）" : "如 127.0.0.1（本机）";
  return (
    <div className={`${FORWARD_GRID[side]} ${rule.enabled ? "" : "opacity-60"}`}>
      <input type="checkbox" aria-label="启用" checked={rule.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
      <div className="relative">
        <input aria-label={c2s ? "本机监听地址" : "服务器监听地址"} className={cell} value={rule.listenHost} onChange={(e) => onChange({ listenHost: e.target.value.trim() })} />
        {c2s && exposesListen(rule) && (
          <span title="监听在非回环地址：局域网内其它机器也能经你的 SSH 通道访问目标" className="absolute right-1.5 top-2 text-amber-600">
            <Icon name="alertTriangle" size={14} />
          </span>
        )}
      </div>
      <PortInput label={c2s ? "本机端口" : "服务器端口"} value={rule.listenPort} placeholder={c2s ? "端口" : "自动"} onChange={(listenPort) => onChange({ listenPort })} />
      {c2s && (
        <div className="forward-kind">
          <SettingsChoice label="类型" value={rule.kind} options={KIND_OPTIONS} onChange={(v) => onChange({ kind: v === "dynamic" ? "dynamic" : "local" })} />
        </div>
      )}
      {rule.kind === "dynamic" ? (
        <span className="col-span-2 text-xs text-muted-foreground">— 由客户端指定 —</span>
      ) : (
        <>
          <input aria-label={c2s ? "目标地址" : "本机目标地址"} title={targetHint} placeholder={targetHint} className={cell} value={rule.targetHost} onChange={(e) => onChange({ targetHost: e.target.value.trim() })} />
          <PortInput label={c2s ? "目标端口" : "本机目标端口"} value={rule.targetPort} placeholder="端口" onChange={(targetPort) => onChange({ targetPort })} />
        </>
      )}
      <input aria-label="备注" className={cell} value={rule.note} placeholder="备注" onChange={(e) => onChange({ note: e.target.value })} />
      {badge.copy ? (
        <button type="button" className={`truncate text-left text-xs hover:underline ${badge.tone}`} title={`${badge.where} ${badge.copy}（点击复制）`} onClick={() => void copyText(badge.copy!)}>
          {badge.text}
        </button>
      ) : (
        <span className={`truncate text-xs ${badge.tone}`} title={badge.title ?? badge.text}>{badge.text}</span>
      )}
      <button type="button" aria-label="删除规则" onClick={onRemove} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive-ink">
        <Icon name="trash" size={13} />
      </button>
    </div>
  );
}
