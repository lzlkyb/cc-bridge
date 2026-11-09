import { useState } from "react";
import type { StaticStatus, ConfigSaveResult } from "../../../lib/types";
import { invoke } from "../../../lib/tauri";
import { isLoopbackHost } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsRow } from "../../ui/SettingsRow";
import { useToast } from "../../ui/toast";

const ALL = "0.0.0.0";
const LOCAL = "127.0.0.1";

/**
 * 监听地址：「所有网卡」/「仅本机」二选一。
 *
 * 为什么要加回来（2026-11-09）：2026-07-10 界面改版删掉了旧的「监听地址」输入框，
 * 但库里的 `host` 还在——旧版里改成 127.0.0.1 的用户（或导入过这种配置的用户）
 * 远程永远连不上、连接页的地址卡片也不显示，而界里没有任何入口能改回去。
 *
 * 不给自由输入：绝大多数人只需要这两档。旧配置里的具体网卡 IP 照实显示成第三个
 * （不可点的）选中项，用户点两档之一就能切走。
 */
export function ListenHostRow({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  /** 已保存但重启失败：此时新值已在库里，再点同一项不会触发保存，必须给独立的重试入口。 */
  const [restartFailed, setRestartFailed] = useState(false);
  const [confirmLocal, setConfirmLocal] = useState(false);

  const host = status?.host ?? ALL;
  const legacy = host !== ALL && host !== LOCAL;

  const restart = async () => {
    await invoke("restart_mcp_server");
    // 端口没变，但绑定地址变了，防火墙诊断结果可能跟着变；失败不影响主流程。
    await invoke("refresh_firewall").catch(() => undefined);
  };

  const commit = async (next: string) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    let persisted = false;
    try {
      const r = await invoke<ConfigSaveResult>("save_config", { patch: { host: next } });
      persisted = true;
      if (r.restartRequired) await restart();
      setRestartFailed(false);
      toast(
        next === ALL ? "已改为监听所有网卡，服务已重启" : "已改为仅监听本机，服务已重启",
        "success",
      );
    } catch (e) {
      setRestartFailed(persisted);
      setError(
        persisted
          ? `监听地址已保存，但服务重启失败：${e}`
          : `监听地址保存失败：${e}`,
      );
    } finally {
      setPending(false);
      onSaved();
    }
  };

  const retryRestart = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await restart();
      setRestartFailed(false);
      toast("服务已重启，已保存的监听地址已生效", "success");
    } catch (e) {
      setError(`监听地址已保存，但服务重启失败：${e}`);
    } finally {
      setPending(false);
      onSaved();
    }
  };

  const pick = (next: string) => {
    if (pending || !status || next === host) return;
    // 切到「仅本机」会把所有远程客户端断掉，必须确认；反方向只会多开放，直接保存。
    if (next === LOCAL) setConfirmLocal(true);
    else void commit(next);
  };

  const options: { key: string; label: string; disabled?: boolean }[] = [
    { key: ALL, label: "所有网卡" },
    { key: LOCAL, label: "仅本机" },
    ...(legacy ? [{ key: host, label: `当前：${host}`, disabled: true }] : []),
  ];

  return (
    <>
      <SettingsRow
        id="network-host"
        label="监听地址"
        sub={
          isLoopbackHost(host)
            ? "当前只监听本机，远程服务器无法连接"
            : legacy
              ? "只监听这一张网卡（旧版设置），换网后可能连不上"
              : "远程服务器可通过本机任一网卡地址连入"
        }
        info={
          <>
            <b>所有网卡</b>（0.0.0.0，默认）：远程 Linux 通过「连接」页选中的地址连回本机。
            <br />
            <b>仅本机</b>（127.0.0.1）：只有本机上的工具能连，远程一律连不上，连接页也不再让你选地址。
            <br />
            切换会重启服务，已连接的客户端会短暂断开。
          </>
        }
        pending={pending}
        error={error}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div role="group" aria-label="监听地址" className="settings-segment flex shrink-0 rounded-lg border bg-muted p-0.5">
              {options.map((o) => {
                const active = host === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    disabled={pending || !status || o.disabled}
                    aria-pressed={active}
                    onClick={() => pick(o.key)}
                    className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      active
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {restartFailed && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void retryRestart()}>
                重试重启服务
              </Button>
            )}
          </div>
        }
      />
      {confirmLocal && (
        <ConfirmDialog
          title="改为只监听本机？"
          description={
            <>
              改为 <b>127.0.0.1</b> 后，<b>所有远程服务器都会连不上</b>本桥，只有本机上的工具能用。
              服务会立即重启。以后可以在这里改回「所有网卡」。
            </>
          }
          variant="destructive"
          confirmLabel="改为仅本机"
          onCancel={() => setConfirmLocal(false)}
          onConfirm={() => {
            setConfirmLocal(false);
            void commit(LOCAL);
          }}
        />
      )}
    </>
  );
}
