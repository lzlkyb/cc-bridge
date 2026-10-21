import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus } from "../../../lib/types";
import { releaseWebviewHint } from "../../../lib/platform";
import { Card, CardContent } from "../../ui/card";
import { Switch } from "../../ui/switch";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/SettingsRow";
import { ToggleRow } from "../../ui/ToggleRow";
import { AppearanceSettings } from "./AppearanceSettings";
import { useSettingSave } from "./useSettingSave";

const noop = () => {};
export function AppGroup({ status, onSaved = noop }: { status?: StaticStatus; onSaved?: () => void } = {}) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const readVersion = useRef(0);
  const { save, isSaved, isPending, errorFor } = useSettingSave(onSaved);
  const readAutostart = useCallback(async () => {
    const version = ++readVersion.current;
    setLoading(true); setError("");
    try {
      const value = await invoke<boolean>("get_autostart");
      if (version === readVersion.current) setAutostart(value);
    } catch {
      if (version === readVersion.current) { setAutostart(null); setError("无法读取开机启动状态，请重试。"); }
    } finally { if (version === readVersion.current) setLoading(false); }
  }, []);
  const cancelRead = useCallback(() => { readVersion.current++; }, []);
  useEffect(() => { void readAutostart(); return cancelRead; }, [readAutostart, cancelRead]);
  const toggle = async (next: boolean) => {
    if (pending || autostart === null) return;
    setPending(true); setError("");
    try { await invoke("set_autostart", { enabled: next }); setAutostart(next); }
    catch { setError("开机自动启动保存失败，原设置未改变，请重试。"); }
    finally { setPending(false); }
  };
  return <Card id="set-app"><CardContent>
    <AppearanceSettings />
    <section className="settings-inner-section" aria-labelledby="startup-title"><h3 id="startup-title">启动与资源</h3>
      <SettingsRow id="app-startup" label="开机自动启动" sub="登录系统后自动启动 CC Bridge" error={error} pending={pending}
        control={<div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{loading ? "读取中…" : autostart === null ? "状态未知" : autostart ? "已开启" : "已关闭"}</span>
          <Switch checked={autostart === true} disabled={loading || pending || autostart === null} onChange={next => { void toggle(next); }} ariaLabel="开机自动启动" />
          {!loading && autostart === null && <Button variant="outline" size="sm" onClick={() => { void readAutostart(); }}>重试</Button>}</div>} />
      <ToggleRow id="toggle-release-webview" label="关窗时释放界面内存" sub="关窗后释放界面，再次打开需要重新加载" info={releaseWebviewHint(status?.platform)}
        checked={status?.releaseWebviewOnClose ?? true} disabled={!status} pending={isPending("release-webview")} error={errorFor("release-webview")} saved={isSaved("release-webview")}
        onChange={value => { void save({ releaseWebviewOnClose: value }, "release-webview"); }} last />
    </section>
  </CardContent></Card>;
}
