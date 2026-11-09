import { useState, useRef } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
  const [exporting, setExporting] = useState(false);
  /** 最近一次导出的完整路径：常驻展示，用户需要拿这个文件去改 / 去发给别人。 */
  const [exportedPath, setExportedPath] = useState("");

  // 🔴 不再用 `<a download>`：WebView2 会把文件静默存进「下载」目录、不给路径，
  // 用户只看到「已导出」却找不到文件（2026-11-09 用户反馈）。改为弹「另存为」让用户选位置，
  // 由后端写盘并回报实际路径。
  const handleExport = async () => {
    if (exporting) return;
    try {
      const target = await save({
        title: "导出 cc-bridge 配置",
        defaultPath: "cc-bridge-config.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!target) return; // 用户取消
      setExporting(true);
      const written = await invoke<string>("export_config_to_file", { path: target });
      setExportedPath(written);
      toast("配置已导出", "success");
    } catch (err) {
      toast(`导出失败：${err}`, "error");
    } finally {
      setExporting(false);
    }
  };

  const reveal = async () => {
    try {
      await revealItemInDir(exportedPath);
    } catch (err) {
      toast(`打开文件夹失败：${err}`, "error");
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
        <CardTitle icon={<Icon name="download" />}>配置迁移</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          导入将覆盖服务配置（包括白名单、Token 和命令执行设置）并重启服务。终端字体、配色等本机偏好不在此导入导出范围；导出的文件含凭据，请妥善保管。
        </p>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleExport} isLoading={exporting} loadingText="导出中..." className="gap-1.5">
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
        {exportedPath && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">已导出到</span>
            <code className="min-w-0 flex-1 break-all font-mono text-foreground">{exportedPath}</code>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs" onClick={() => void reveal()}>
              <Icon name="folder" size={13} />
              在文件夹中显示
            </Button>
          </div>
        )}
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
              将用 <b>{pendingFile.name}</b> 覆盖当前服务配置（白名单、Token、命令执行等安全开关，不含终端字体与配色等本机偏好）并自动重启服务，
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
