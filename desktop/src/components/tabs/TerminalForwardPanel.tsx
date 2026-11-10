import { useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { SettingsChoice } from "../ui/SettingsChoice";
import { toast } from "../ui/toast";
import { invoke } from "../../lib/tauri";
import { matchesRunning, startTunnel, useTunnelStatus } from "../../lib/sshTunnelStore";
import type { ForwardAuto, SshConnection, TunnelStatus } from "../../lib/types";
import { ForwardSection } from "./ForwardSection";
import { useForwardDraft } from "./useForwardDraft";

const STATE_PILL: Record<TunnelStatus["state"], { text: string; tone: string }> = {
  connecting: { text: "连接中", tone: "bg-muted text-muted-foreground" },
  up: { text: "运行中", tone: "bg-green-500/15 text-green-700 dark:text-green-400" },
  reconnecting: { text: "重连中", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  error: { text: "已停止", tone: "bg-destructive/15 text-destructive-ink" },
  stopped: { text: "未开启", tone: "bg-muted text-muted-foreground" },
};

/** 从最被动到最主动。一个设置管完「什么时候自动开」，不会出现两个开关互相打架。 */
const AUTO_OPTIONS: { value: ForwardAuto; label: string }[] = [
  { value: "off", label: "不自动" },
  { value: "ask", label: "连接时询问" },
  { value: "connect", label: "连接时开启" },
  { value: "launch", label: "随 cc-bridge 启动" },
];
const AUTO_HINT: Record<ForwardAuto, string> = {
  off: "只在这里手动开启。",
  ask: "主动连接终端时弹出提示，询问是否同时开启。",
  connect: "主动连接终端时直接开启，不再询问。",
  launch: "cc-bridge 一启动就开启，不用打开终端（只用已保存的密码/口令）。",
};

/**
 * 端口转发面板：覆盖在终端区之上，对着一条连接编辑规则、开停转发。
 * 转发进程与终端会话无关：不开终端也能转发，关掉面板转发照常跑。
 */
export function TerminalForwardPanel({ conn, onBack }: { conn: SshConnection; onBack: () => void }) {
  const status = useTunnelStatus(conn.id);
  const d = useForwardDraft(conn);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");

  const running = status && status.state !== "error" ? status : undefined;
  const pill = STATE_PILL[status?.state ?? "stopped"];
  const hasEnabled = d.rules.some((r) => r.enabled);
  const needsApply = !!running && (d.dirty || !matchesRunning(d.rules, running));

  const start = async (oneTime?: string) => {
    setBusy(true);
    try {
      if (d.dirty && !(await d.save())) return;
      const creds = !oneTime ? undefined : conn.authType === "key" ? { passphrase: oneTime } : { password: oneTime };
      if (await startTunnel(conn, creds)) setSecret("");
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await invoke("ssh_tunnel_stop", { connectionId: conn.id });
    } catch (e) {
      toast(`停止转发失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (await d.save()) toast(running ? "已保存，点「保存并应用」生效" : "转发设置已保存", "success");
  };

  return (
    <div className="terminal-forward-panel absolute inset-0 z-10 flex flex-col overflow-hidden bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <button type="button" onClick={onBack} aria-label="返回终端" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
          <Icon name="arrowLeft" size={15} />
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">端口转发 · {conn.name || conn.host}</div>
          <div className="truncate text-xs text-muted-foreground">{conn.username}@{conn.host}:{conn.port}</div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.text}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!d.dirty || busy} isLoading={d.saving && !busy} onClick={() => void save()}>保存</Button>
          {running ? (
            <>
              <Button size="sm" disabled={!needsApply || !hasEnabled} isLoading={busy} onClick={() => void start()}>保存并应用</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void stop()}><Icon name="power" size={13} /> 停止</Button>
            </>
          ) : (
            <Button size="sm" disabled={!hasEnabled} isLoading={busy} onClick={() => void start()}><Icon name="play" size={13} /> 开启转发</Button>
          )}
        </div>
      </div>

      {status?.message && (
        <div className={`border-b px-4 py-2 text-xs ${status.state === "error" ? "text-destructive-ink" : "text-muted-foreground"}`}>{status.message}</div>
      )}
      {status?.state === "error" && status.needsSecret && (
        <form className="flex items-center gap-2 border-b px-4 py-2" onSubmit={(e) => { e.preventDefault(); void start(secret); }}>
          <input type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={conn.authType === "key" ? "密钥口令" : "登录密码"} className="h-8 w-56 rounded-md border border-input bg-background px-2 text-xs" />
          <Button size="sm" type="submit" disabled={!secret} isLoading={busy}>输入并开启</Button>
          <span className="text-xs text-muted-foreground">只保留在内存里供断线重连，停止转发即丢弃</span>
        </form>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
        <ForwardSection side="c2s" rules={d.rules.filter((r) => r.kind !== "remote")} running={running} onAdd={() => d.add("local")} onChange={d.update} onRemove={d.remove} />
        <ForwardSection side="s2c" rules={d.rules.filter((r) => r.kind === "remote")} running={running} onAdd={() => d.add("remote")} onChange={d.update} onRemove={d.remove} />
      </div>

      <div className="space-y-2 border-t px-4 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-foreground">自动开启转发</span>
          <SettingsChoice label="自动开启转发" value={d.auto} options={AUTO_OPTIONS} onChange={(v) => d.setAuto(v as ForwardAuto)} />
        </div>
        <p className="text-muted-foreground">{AUTO_HINT[d.auto]}转发在后台运行，与终端会话无关；断线自动重连，关闭 SSH 总开关或退出 cc-bridge 时停止。</p>
      </div>
    </div>
  );
}
