import { useEffect, useState } from "react";
import { invoke } from "../../../../lib/tauri";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { Spinner } from "../../../ui/Spinner";
import { ConfirmModal } from "../../../ui/ConfirmModal";
import { useToast } from "../../../ui/toast";
import { CandidateRow } from "./CandidateRow";
import {
  fullCommand,
  type McpBridgeCandidate,
  type McpBridgeInspect,
  type McpBridgeScan,
} from "./types";

/**
 * 导入向导。
 *
 * 三条硬规矩写进了界面：
 * 1. **全部保持关闭**（S2）——确认按钮写死了“保持关闭”三个字，不能只写“导入”；
 *    只写导入的话，用户会默认导入即生效。
 * 2. **不可导入的也列出来**（§9）——直接不显示会让用户以为扫漏了，
 *    然后去手动添加一个本就不能用的。
 * 3. **扫描零进程**——启进程只能由用户逐条点「运行一下」触发。
 */
export function ImportWizard({
  master,
  onCancel,
  onImport,
}: {
  /** 总开关。关着时不允许运行候选（后端也会拒，这里只是提前置灰）。 */
  master: boolean;
  onCancel: () => void;
  onImport: (names: string[]) => Promise<unknown>;
}) {
  const [scan, setScan] = useState<McpBridgeScan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
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

  /**
   * 运行一条候选。**会真的启动子进程**（后端拿完清单立刻关掉）。
   *
   * 失败不弹 toast 就算了：错误原文（带对方 stderr）直接写回那一行，
   * 弹一下就没的话，用户根本来不及看完那段 stderr。
   */
  const inspect = async (name: string) => {
    setRunning(name);
    try {
      const r = await invoke<McpBridgeInspect>("mcp_bridge_inspect", { name });
      setScan((prev) =>
        prev
          ? {
              ...prev,
              candidates: prev.candidates.map((c) =>
                c.name === name
                  ? {
                      ...c,
                      tools: r.tools,
                      toolCount: r.toolCount,
                      instructions: r.instructions,
                      // 失败时把行置为 unavailable，原文就地显示。
                      ...(r.state === "failed"
                        ? { state: "unavailable" as const, reason: r.error ?? "启动失败" }
                        : {}),
                    }
                  : c,
              ),
            }
          : prev,
      );
    } catch (e) {
      // 这一支是后端直接拒了（总开关关着 / 候选没了），不属于“这条启不起来”。
      toast(`${e}`, "error");
    } finally {
      setRunning(null);
    }
  };

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
          <CandidateRow
            key={c.name}
            c={c}
            picked={picked.has(c.name)}
            running={running === c.name}
            masterOff={!master}
            onToggle={() => toggle(c.name)}
            onInspect={() => void inspect(c.name)}
          />
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
      {/* 原文可能是多行的 stderr，不能当成一行渲染。 */}
      <div className="mt-0.5 whitespace-pre-wrap text-[11px] text-muted-foreground">{c.reason}</div>
      <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
        {fullCommand(c.command, c.args)}
      </div>
    </div>
  );
}
