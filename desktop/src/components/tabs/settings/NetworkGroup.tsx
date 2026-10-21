import { useState, useEffect, useRef } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus, ConfigSaveResult } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";
import { SettingsRow } from "../../ui/SettingsRow";
import { SavedHint } from "../../ui/SavedHint";
import { InlineNotice } from "../../ui/notice";
import { TransportRow } from "./TransportRow";


/* ─── 网络 ─── */

export function NetworkGroup({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const [port, setPort] = useState("7823");
  const [saving, setSaving] = useState(false);
  const [restarted, setRestarted] = useState(false);
  const [transportSaved, setTransportSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const { toast } = useToast();

  // 仅在用户未偏离（当前输入仍等于上次同步的服务端值）时跟随服务端回填；
  // 用户正在编辑偏离值时保留输入，避免 App 层 5s 轮询（refetchInterval）把输入框冲掉。
  // 对比 settings/BackupAuditGroup.tsx 用 initialized 仅首次回填，这里用「偏离检测」
  // 兼顾「外部改端口后跟随」。
  const syncedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!status) return;
    const serverPort = status.port;
    setPort((prev) => {
      const follow = syncedRef.current === null || prev === String(syncedRef.current);
      syncedRef.current = serverPort;
      return follow ? String(serverPort) : prev;
    });
  }, [status]);

  const dirty = status ? port !== String(status.port) : false;
  // 端口范围校验：1–65535 的整数
  const valid = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const invalid = !valid;

  const handleSaveAndRestart = async () => {
    if (!valid || saving) return;
    setSaveError("");
    setSaving(true);
    let persisted = false;
    try {
      const result = await invoke<ConfigSaveResult>("save_config", {
        patch: { port: Number(port) },
      });
      persisted = true;
      if (result.restartRequired) {
        await invoke("restart_mcp_server");
        // 防火墙联动：端口变了 → 旧端口规则残留、新端口无放行规则。主动刷新
        // 缓存使「连接」页防火墙告警块基于新端口正确显示（未放行时提示一键开放）。
        await invoke("refresh_firewall").catch((e) =>
          toast(`刷新防火墙失败：${e}`, "error"),
        );
        setRestarted(true);
        if (status?.firewallEnabled === true) {
          toast(
            "端口已更新，服务已重启。若远程无法连接，请到「连接」页为新端口开放防火墙",
            "success",
          );
        } else {
          toast("端口已更新，服务已重启", "success");
        }
        timers.current.push(setTimeout(() => setRestarted(false), 3000));
      } else {
        toast("端口已保存", "success");
      }
      onSaved();
    } catch (e) {
      const message = persisted ? `端口已保存，但服务重启失败：${String(e)}。请重试重启服务。` : `端口保存失败：${String(e)}`;
      setSaveError(message);
      toast(message, "error");
      if (persisted) onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card id="set-network">
      <CardHeader>
        <CardTitle icon={<Icon name="server" />}>服务监听</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 端口 + 按钮 同一行（统一到 SettingsRow）*/}
        <SettingsRow
          id="network-port" controlId="network-port-input"
          error={saveError} pending={saving}
          label="端口"
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Input id="network-port-input"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                disabled={saving || !status}
                className={`w-28! flex-none ${invalid ? "border-destructive focus-visible:ring-destructive" : ""}`}
                aria-label="监听端口"
                aria-invalid={invalid}
              />
              {/* 原先旁边还有一个常驻的「无更改」文字，已删：按钮 disabled 表达的是
                  同一件事。信息没丢，搬到了 title（悬停仍能知道为何不可点）。 */}
              <Button
                onClick={handleSaveAndRestart}
                disabled={!dirty || saving || invalid}
                isLoading={saving}
                loadingText="保存中..."
                size="sm"
                className="min-w-24 shrink-0 whitespace-nowrap"
                title={invalid ? "端口超出 1 – 65535" : dirty ? undefined : "端口未修改"}
              >
                {dirty ? "保存并重启" : "保存"}
              </Button>
              {restarted && <SavedHint className="whitespace-nowrap">已保存并重启</SavedHint>}
            </div>
          }
        />
        {invalid && <p className="text-xs text-destructive-ink">端口范围 1 – 65535</p>}
        {/* 传输协议从原「功能开关 › 兼容与性能」搬到这里：它决定远程怎么连，
            与监听端口同类，和“兼容”无关。 */}
        <TransportRow
          status={status}
          saved={transportSaved}
          onSelect={async (v) => {
            try {
              await invoke<ConfigSaveResult>("save_config", { patch: { transport: v } });
              onSaved();
              setTransportSaved(true);
              timers.current.push(setTimeout(() => setTransportSaved(false), 1500));
              return true;
            } catch (e) {
              toast(`保存失败：${e}`, "error");
              return false;
            }
          }}
          last
        />
        {status?.firewallEnabled === false && (
          <InlineNotice variant="warning">
            <b>检测到 Windows 防火墙已关闭。</b>
            远程仍可连入，但本机缺少网络层防护，建议仅在可信网络下保持此状态，并尽快重新启用防火墙。
          </InlineNotice>
        )}
        {/* 重启警告只在端口真被改过时出现。
            原来是常驻的，但用户没改端口时这句话毫无作用，却每次进设置页占
            44px + 12px 间隙（整张卡 269px 里的 21%）。而信息本身并未丢失：
            按钮文案就是「保存并重启」，且真正需要提醒的时刻（刚改完）它会立即出现——
            比常驻在那里被忽略更醒目。 */}
        {dirty && (
          <InlineNotice variant="warning">
            <b>保存将重启服务</b>，已连接的客户端会短暂断开。
          </InlineNotice>
        )}
      </CardContent>
    </Card>
  );
}
