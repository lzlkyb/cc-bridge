import { useState, useRef } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus, ConfigSaveResult } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

/* ─── 配置导入/导出（C8）─── */

export function ConfigGroup({
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

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

  // H2 修复：选中文件不再立即导入（之前只靠静态文案提示，选中即刻覆盖全部配置并重启，一次误选
  // 就会清空当前全部安全设置且不可撤销）：先暂存文件弹 ConfirmDialog，确认后才真正 invoke。
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
  };

  const doImport = async (file: File) => {
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
    <Card id="set-config">
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
        {/* 原先这里有一个常驻的⚠「导入将覆盖所有当前配置」警告框，已删。
            与网络卡那条完全同型：用户不导入时它毫无作用，却每次进设置页占 ~56px。
            信息没丢，而且下面的 ConfirmDialog 说得**更全**：它列出了覆盖哪些设置
            （白名单 / Token / 命令执行等）、会重启服务、不可撤销，并带上了具体文件名——
            而那才是用户真正要做决定的时刻。 */}
      </CardContent>
      {pendingFile && (
        <ConfirmDialog
          title="确定导入此配置文件？"
          description={
            <>
              将用 <b>{pendingFile.name}</b> 覆盖当前全部配置（白名单、Token、命令执行等安全开关）并自动重启服务，
              且不可撤销。请确认此文件来自可信来源。
            </>
          }
          variant="destructive"
          confirmLabel="确定导入"
          onCancel={() => {
            setPendingFile(null);
            if (fileRef.current) fileRef.current.value = "";
          }}
          onConfirm={() => {
            const file = pendingFile;
            setPendingFile(null);
            void doImport(file);
          }}
        />
      )}
    </Card>
  );
}
