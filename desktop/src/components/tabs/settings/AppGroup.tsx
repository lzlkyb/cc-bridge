import { useState, useEffect } from "react";
import { invoke } from "../../../lib/tauri";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../../ui/SettingsRow";
import { useToast } from "../../ui/toast";
import { AppearanceSettings } from "./AppearanceSettings";

/* ─── 应用 ─── */

export function AppGroup() {
  const [autostart, setAutostart] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { toast } = useToast();
  // 失败抖动（2026-10-17）：之前失败只静默 revert，用户以为开成功了（审查 #17 唯一
  // 反模式）。现在 revert 的同时开关震一下 + error toast。key 自增重挂 Switch，
  // 重播一次 animate-shake（一次性动画，与 StatusCard 报错块同款）。
  const [shakeKey, setShakeKey] = useState(0);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then((v) => {
        setAutostart(v);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const toggle = async () => {
    const next = !autostart;
    setAutostart(next);
    try {
      await invoke("set_autostart", { enabled: next });
    } catch {
      setAutostart(!next); // revert on failure
      setShakeKey((k) => k + 1);
      toast("开机自启设置失败，请重试", "error");
    }
  };

  return (
    <Card id="set-app">
      <CardHeader>
        <CardTitle icon={<Icon name="monitor" />}>应用</CardTitle>
      </CardHeader>
      <CardContent>
        <AppearanceSettings />
        <SettingsRow
          label="开机自动启动"
          last
          control={
            <span key={shakeKey} className={`inline-flex ${shakeKey > 0 ? "animate-shake" : ""}`}>
              <Switch checked={autostart} disabled={!loaded} onChange={() => toggle()} ariaLabel="开机自动启动" />
            </span>
          }
        />
      </CardContent>
    </Card>
  );
}
