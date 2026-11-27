import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "../../../lib/tauri";
import { Card, CardContent } from "../../ui/card";
import { Switch } from "../../ui/switch";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/SettingsRow";
import { AppearanceSettings } from "./AppearanceSettings";
import { SoftwareUpdateSettings } from "./SoftwareUpdateSettings";

export function AppGroup({ currentVersion }: { currentVersion?: string }) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const readVersion = useRef(0);
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
      <SettingsRow id="app-startup" label="开机自动启动" sub="登录系统后自动启动 CC Bridge" error={error} pending={pending} last
        control={<div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{loading ? "读取中…" : autostart === null ? "状态未知" : autostart ? "已开启" : "已关闭"}</span>
          <Switch checked={autostart === true} disabled={loading || pending || autostart === null} onChange={next => { void toggle(next); }} ariaLabel="开机自动启动" />
          {!loading && autostart === null && <Button variant="outline" size="sm" onClick={() => { void readAutostart(); }}>重试</Button>}</div>} />
    </section>
    <SoftwareUpdateSettings currentVersion={currentVersion} />
  </CardContent></Card>;
}
