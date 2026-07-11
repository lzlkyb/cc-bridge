import { useState, useEffect, useRef } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../lib/types";
import { APP_INFO } from "../../lib/about";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { SettingsToggles } from "./SettingsToggles";
import { AboutGroup } from "./AboutGroup";

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
    <div className="space-y-4">
      <AboutGroup status={status} />
      <NetworkGroup status={status} onSaved={onSaved} />
      <SettingsToggles status={status} onSaved={onSaved} highlightAnchor={highlightAnchor} />
      <AppGroup />
      <ConfigGroup status={status} onSaved={onSaved} />
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
  // 端口范围校验：1–65535 的整数
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const invalid = !valid;

  const handleSaveAndRestart = async () => {
    if (!valid) return;
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
      <CardContent className="space-y-3">
        {/* 端口 + 按钮 同一行 */}
        <div className="flex items-center gap-3">
          <Label className="shrink-0">端口</Label>
          <Input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            className={`max-w-[120px] ${invalid ? "border-destructive focus-visible:ring-destructive" : ""}`}
          />
          <Button
            onClick={handleSaveAndRestart}
            disabled={!dirty || saving || invalid}
            isLoading={saving}
            loadingText="保存中..."
            size="sm"
          >
            {dirty ? "保存并重启" : "保存"}
          </Button>
          {!dirty && !restarted && <span className="text-xs text-muted-foreground">无更改</span>}
          {restarted && <span className="text-xs text-success">已保存并重启 ✓</span>}
        </div>
        {invalid && <p className="text-xs text-destructive">端口范围 1 – 65535</p>}
        <div className="warn-box flex items-start gap-2.5 rounded-lg p-3">
          <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
          <p className="text-[11px] leading-relaxed">
            <b>修改端口将重启服务</b>，已连接的客户端会短暂断开。
          </p>
        </div>
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
              {`系统登录后自动在后台启动 ${APP_INFO.name}，远程随时可连接。`}
            </p>
          </div>
          <Toggle checked={autostart} disabled={!loaded} onChange={toggle} ariaLabel="开机自动启动" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── 配置导入/导出（C8）─── */

function ConfigGroup({
  onSaved,
}: {
  status?: StatusResponse;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    try {
      const json = await invoke<string>("export_config");
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cc-bridge-config.json";
      a.click();
      URL.revokeObjectURL(url);
      toast("配置已导出", "success");
    } catch (err) {
      toast(`导出失败：${err}`, "error");
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      await invoke<ConfigSaveResult>("import_config", { json: text });
      toast("配置已导入并重启服务", "success");
      onSaved();
    } catch (err) {
      toast(`导入失败：${err}`, "error");
    } finally {
      setImporting(false);
      // 清空 input 以便再次选同一个文件
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="download" />}>配置</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          导出当前配置为 JSON 文件，或导入之前导出的配置。导入会覆盖当前设置并自动重启服务。
        </p>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
            <Icon name="download" size={14} />
            导出配置
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            isLoading={importing}
            loadingText="导入中..."
            className="gap-1.5"
          >
            <Icon name="upload" size={14} />
            导入配置
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </div>
        <div className="warn-box flex items-start gap-2.5 rounded-lg p-3">
          <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
          <p className="text-xs leading-relaxed">
            <b>导入将覆盖所有当前配置</b>并重启服务。请确认导入文件来自可信来源。
          </p>
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

  // 归一化：空输入 / NaN / 负值统一为 0（配合 Input min=0），并取整。
  const normalize = (raw: number) => (Number.isNaN(raw) || raw < 0 ? 0 : Math.floor(raw));

  const handleChange = (raw: number) => {
    const val = normalize(raw);
    setDays(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // 触发后清空 ref，供 onBlur 判断是否已保存，避免双次保存。
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      save(val);
    }, 800);
  };

  // onBlur 仅在 debounce 仍挂起（尚未保存）时立即保存，已保存则不重复。
  const handleBlur = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
      save(days);
    }
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
          min={0}
          value={days}
          onChange={(e) => handleChange(Number(e.target.value))}
          onBlur={handleBlur}
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
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
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
