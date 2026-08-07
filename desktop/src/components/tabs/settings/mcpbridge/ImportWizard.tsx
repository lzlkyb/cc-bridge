import { useEffect, useState } from "react";
import { invoke } from "../../../../lib/tauri";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { Spinner } from "../../../ui/Spinner";
import { ConfirmModal } from "../../../ui/ConfirmModal";
import { useToast } from "../../../ui/toast";
import { fullCommand, type McpBridgeCandidate, type McpBridgeScan } from "./types";

/**
 * 导入向导。
 *
 * 两条硬规矩写进了界面：
 * 1. **全部保持关闭**（S2）——确认按钮写死了“保持关闭”三个字，不能只写“导入”；
 *    只写导入的话，用户会默认导入即生效。
 * 2. **不可导入的也列出来**（§9）——直接不显示会让用户以为扫漏了，
 *    然后去手动添加一个本就不能用的。
 */
export function ImportWizard({
  onCancel,
  onImport,
}: {
  onCancel: () => void;
  onImport: (names: string[]) => Promise<unknown>;
}) {
  const [scan, setScan] = useState<McpBridgeScan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let alive = true;
    invoke<McpBridgeScan>("mcp_bridge_scan")
      .then((r) => alive && setScan(r))
      .catch((e) => toast(`扫描失败：${e}`, "error"));
    return () => {
      alive = false;
    };
  }, [toast]);

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const ok = scan?.candidates.filter((c) => c.state === "importable") ?? [];
  const bad = scan?.candidates.filter((c) => c.state !== "importable") ?? [];

  return (
    <ConfirmModal open onClose={onCancel} maxWidth="lg">
      <h4 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Icon name="download" size={18} />
        从已有配置导入
      </h4>

      <div className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
        导入只是把配置<b>抄过来</b>，全部保持关闭。导入后需要你逐个开启，每个都会再确认一次。
      </div>

      {!scan && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner size={14} />
          正在扫描本机已有的 MCP 配置…
        </div>
      )}

      {scan && ok.length === 0 && bad.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">
          没扫到任何 MCP 配置。已查看 <code className="font-mono">~/.claude.json</code>、
          <code className="font-mono">~/.cursor/mcp.json</code> 与 Claude Desktop 的配置文件。
        </p>
      )}

      <div className="max-h-[46vh] overflow-y-auto">
        {ok.length > 0 && (
          <div className="mb-1.5 text-[11px] text-muted-foreground">
            可导入 {ok.length} 项{scan?.sources.length ? ` · 来自 ${scan.sources.join("、")}` : ""}
          </div>
        )}
        {ok.map((c) => (
          <button
            key={c.name}
            type="button"
            onClick={() => toggle(c.name)}
            className={`mb-1.5 flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left ${
              picked.has(c.name) ? "border-primary/35 bg-primary/8" : ""
            }`}
          >
            <span
              className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                picked.has(c.name) ? "border-primary bg-primary text-primary-foreground" : ""
              }`}
            >
              {picked.has(c.name) && <Icon name="check" size={11} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                {c.name}
                {c.renamedFrom && (
                  <span className="rounded-full bg-warning/14 px-2 py-0.5 text-[10px] font-normal text-warning">
                    已存在同名，导入为此名（原：{c.renamedFrom}）
                  </span>
                )}
              </span>
              {/* 完整命令（S0）：`D:` 这种参数必须在勾选前就看得见。 */}
              <span className="mt-1 block break-all rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
                {fullCommand(c.command, c.args)}
              </span>
              {c.envKeys.length > 0 && (
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  环境变量：{c.envKeys.join("、")}
                  <span className="ml-1.5 text-success">值已隐藏</span>
                </span>
              )}
            </span>
          </button>
        ))}

        {bad.length > 0 && (
          <>
            {/* 已导入的不是“无法桥接”（它本就桥着），混在一起时标题得改口径。*/}
            <div className="mb-1.5 mt-3.5 text-[11px] text-muted-foreground">
              以下 {bad.length} 项不可勾选
              {bad.some((c) => c.state === "already_imported") ? "（已导入 / 无法桥接）" : "：无法桥接"}
            </div>
            {bad.map((c) => (
              <UnavailableRow key={`${c.source}/${c.name}`} c={c} />
            ))}
          </>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={picked.size === 0 || saving}
          onClick={async () => {
            setSaving(true);
            await onImport([...picked]);
            onCancel();
          }}
        >
          {saving && <Spinner size={12} />}
          导入选中的 {picked.size} 项（保持关闭）
        </Button>
      </div>
    </ConfirmModal>
  );
}

function UnavailableRow({ c }: { c: McpBridgeCandidate }) {
  return (
    <div className="mb-1.5 rounded-lg border bg-muted/60 px-2.5 py-2 opacity-70">
      <div className="text-[13px] font-semibold">{c.name}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{c.reason}</div>
      <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
        {fullCommand(c.command, c.args)}
      </div>
    </div>
  );
}
