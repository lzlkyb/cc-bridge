import { useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { SavedHint } from "../../ui/SavedHint";
import { useToast } from "../../ui/toast";
import { buildBaseCommand } from "../../../lib/utils";

/**
 * MCP 传输协议选择（HTTP / SSE）。从原「功能开关 › 兼容与性能」搬到「网络」卡：
 * 它决定远程怎么连，与监听端口同类，与“兼容”无关。
 *
 * SSE 确认弹框收在本组件内部（原先散在父组件）：切 SSE 必须到远端换连接命令，
 * 这个确认是切换动作固有的一部分，不应该让每个调用方自己接一遍。
 * `onSelect` 只在**已确认**后被调用。
 */
export function TransportRow({
  status,
  onSelect,
  saved,
  last = false,
}: {
  status?: StaticStatus;
  onSelect: (next: "http" | "sse") => void;
  saved?: boolean;
  last?: boolean;
}) {
  const [confirmSse, setConfirmSse] = useState(false);
  const { toast } = useToast();
  const value = status?.transport ?? "http";
  const options: { key: "http" | "sse"; label: string }[] = [
    { key: "http", label: "HTTP" },
    { key: "sse", label: "SSE" },
  ];
  const handleSelect = (next: "http" | "sse") => {
    if (next === "sse") {
      setConfirmSse(true);
    } else {
      onSelect("http");
    }
  };
  return (
    <>
    <div
      className={`flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">MCP 传输协议</span>
          {saved && <SavedHint>已保存</SavedHint>}
        </div>
        {/* 收成一行。原有的「切换后需到远端替换连接命令」已删——不是丢信息：
            下面的 SseMigrationModal 里不仅说了这事，还直接给出迁移命令 + 复制按钮，
            并要求用户点「我已复制，确认切换」。常态下重复这句只是白占一行。 */}
        <div className="mt-0.5 text-xs text-muted-foreground">
          默认 <b>HTTP</b>（稳定兼容）；<b>SSE</b> 让 run_command 输出实时推送
        </div>
      </div>
      <div className="flex shrink-0 rounded-lg border bg-muted p-0.5">
        {options.map((o) => {
          const active = value === o.key;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => handleSelect(o.key)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>

    {confirmSse && (
      <SseMigrationModal
        status={status}
        onCancel={() => setConfirmSse(false)}
        onConfirm={() => {
          onSelect("sse");
          setConfirmSse(false);
          toast("已切换到 SSE，请到远端执行迁移命令", "success");
        }}
      />
    )}
    </>
  );
}

function SseMigrationModal({
  status,
  onCancel,
  onConfirm,
}: {
  status?: StaticStatus;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { toast } = useToast();
  const host = status?.host ?? "0.0.0.0";
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";
  const sseCmd = buildBaseCommand(host, port, token, "sse");
  const migrationCmd = `claude mcp remove cc-bridge && ${sseCmd}`;

  const copyMigration = async () => {
    try {
      await navigator.clipboard.writeText(migrationCmd);
      toast("已复制，请到远端终端粘贴执行", "success");
    } catch {
      toast("复制失败，请手动复制", "warning");
    }
  };

  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <Icon name="alertCircle" size={18} className="text-primary" />
        切换到 SSE（流式传输）
      </h4>
      <p className="mb-3 text-sm text-muted-foreground">
        切换后 run_command 输出会实时推送到远端。请先复制下方命令到远端终端执行，再点「确认切换」。
      </p>
      <div className="relative mb-2">
        <pre className="rounded-md bg-slate-900 px-3 py-2.5 text-[11px] leading-relaxed text-slate-200 overflow-x-auto whitespace-pre-wrap break-all">
{migrationCmd}
        </pre>
        <button
          type="button"
          className="absolute right-2 top-2 rounded px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 transition-colors"
          onClick={copyMigration}
        >
          📋 复制
        </button>
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground">
        💡 如果之前用了 <code>--scope project</code>，请在 remove 命令后也加上
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="default" size="sm" onClick={onConfirm}>
          我已复制，确认切换
        </Button>
      </div>
    </ConfirmModal>
  );
}
