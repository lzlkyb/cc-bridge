import { useState, useEffect } from "react";
import { invoke } from "../../../lib/tauri";
import { APP_INFO } from "../../../lib/about";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../../ui/SettingsRow";

/* ─── 应用 ─── */

export function AppGroup() {
  const [autostart, setAutostart] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
    }
  };

  return (
    <Card id="set-app">
      <CardHeader>
        <CardTitle icon={<Icon name="monitor" />}>应用</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingsRow
          label="开机自动启动"
          sub={`系统登录后自动在后台启动 ${APP_INFO.name}，远程随时可连接。`}
          last
          control={
            <Switch checked={autostart} disabled={!loaded} onChange={() => toggle()} ariaLabel="开机自动启动" />
          }
        />
      </CardContent>
    </Card>
  );
}
