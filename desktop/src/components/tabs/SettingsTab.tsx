import { useState, useEffect, useRef } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { SettingsToggles } from "./SettingsToggles";
import { UpdateGroup } from "./UpdateGroup";

export function SettingsTab({
  status,
  onSaved,
  highlightAnchor,
}: {
  status?: StatusResponse;
  onSaved: () => void;
  highlightAnchor?: { anchor: string; nonce: number } | null;
}) {
  return (
    <div className="space-y-3">
      <UpdateGroup status={status} />
      <div className="divider-grad" />
      <NetworkGroup status={status} onSaved={onSaved} />
      <div className="divider-grad" />
      <SettingsToggles status={status} onSaved={onSaved} highlightAnchor={highlightAnchor} />
      <div className="divider-grad" />
      <AppGroup />
      <div className="divider-grad" />
      <AuditGroup status={status} onSaved={onSaved} />
    </div>
  );
}

/* ─── 网络 ─── */

function NetworkGroup({
  status,
  onSaved,
}: {
  status?: StatusResponse;
  onSaved: () => void;
}) {
  const [port, setPort] = useState(7823);
  const [saving, setSaving] = useState(false);
  const [restarted, setRestarted] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (status) setPort(status.port);
  }, [status]);

  const dirty = status ? port !== status.port : false;

  const handleSaveAndRestart = async () => {
    setSaving(true);
    try {
      const result = await invoke<ConfigSaveResult>("save_config", {
        patch: { port },
      });
      if (result.restartRequired) {
        await invoke("restart_mcp_server");
        setRestarted(true);
        toast("端口已更新，服务已重启", "success");
        setTimeout(() => setRestarted(false), 3000);
      } else {
        toast("端口已保存", "success");
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="server" />}>网络</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>端口</Label>
          <Input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            className="max-w-[200px]"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSaveAndRestart} disabled={!dirty || saving}>
            {saving ? "保存中..." : dirty ? "保存并重启服务" : "保存"}
          </Button>
          {restarted && <span className="text-sm text-success">已保存并重启 ✓</span>}
        </div>
        {dirty && (
          <p className="text-xs text-muted-foreground">
            端口冲突时可在此修改，保存后自动重启服务。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── 应用 ─── */

function AppGroup() {
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
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="monitor" />}>应用</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>开机自动启动</Label>
            <p className="text-xs text-muted-foreground">
              系统登录后自动在后台启动 cc-bridge，远程随时可连接。
            </p>
          </div>
          <Toggle checked={autostart} disabled={!loaded} onChange={toggle} />
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── 审计 ─── */

function AuditGroup({
  status,
  onSaved,
}: {
  status?: StatusResponse;
  onSaved: () => void;
}) {
  const [days, setDays] = useState(30);
  const [saved, setSaved] = useState(false);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (status && !initialized.current) {
      setDays(status.auditRetentionDays);
      initialized.current = true;
    }
  }, [status]);

  const save = async (val: number) => {
    await invoke<ConfigSaveResult>("save_config", {
      patch: { auditRetentionDays: val },
    });
    onSaved();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleChange = (val: number) => {
    setDays(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(val), 800);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="file" />}>审计</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2">
          <Label>审计日志保留天数</Label>
          {saved && <span className="text-xs text-success">已保存 ✓</span>}
        </div>
        <Input
          type="number"
          value={days}
          onChange={(e) => handleChange(Number(e.target.value))}
          onBlur={() => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            save(days);
          }}
        />
        <p className="text-xs text-muted-foreground">
          超过保留天数的审计记录会在每次启动时自动清理。设为 0 表示永久保留。
        </p>
      </CardContent>
    </Card>
  );
}

/* ─── Toggle switch ─── */

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
