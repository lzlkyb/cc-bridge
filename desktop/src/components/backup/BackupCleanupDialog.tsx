import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import type { BackupCleanupPreview, BackupCleanupResult } from "../../lib/types";
import { formatBytes } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { OptionChip } from "../ui/OptionChip";
import { NumBox } from "../ui/NumBox";
import { BackupCleanupPreviewPanel } from "./BackupCleanupPreviewPanel";

type Mode = "olderThanDays" | "toTotalMb" | "all";

const DAY_PRESETS = [7, 30, 90];
const MB_PRESETS = [100, 300, 1024];

/**
 * 备份高级清理弹窗（设计稿 design/备份与审计-高级清理-设计稿.html 态 2~5）。
 *
 * 三条设计约束落在这个组件里：
 *  1. **预览不可跳过，且确认的就是预览那一份**：确认时把预览返回的 `victims`
 *     路径清单原样回传，后端只删这份清单（不重新按条件算）。
 *     并用 argsKey 锁住：预览参数 ≠ 当前参数时确认按钮置灰——否则改完条件的
 *     去抖窗口里（300ms）按钮仍可点且显示旧数字，最坏情况是用户刚关掉保留底线、
 *     红字警告还没渲染出来就把某些文件的最后一份备份删了。
 *  2. **底线默认开**：`keepLastOne` 初始为 true，把按天清理从破坏性操作变成
 *     安全操作；要彻底删干净得用户自己关掉。
 *  3. **后果可见**：底线关掉后若有文件会失去全部备份，预览区必须出红字
 *     （具体渲染在 BackupCleanupPreviewPanel），并提供「开启底线重算」退路。
 */
export function BackupCleanupDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** 清理成功后回调：刷新统计并让调用方失效备份列表缓存。 */
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>("olderThanDays");
  const [days, setDays] = useState(90);
  const [targetMb, setTargetMb] = useState(300);
  const [keepLastOne, setKeepLastOne] = useState(true);
  const [customDay, setCustomDay] = useState(false);
  const [customMb, setCustomMb] = useState(false);
  const [preview, setPreview] = useState<BackupCleanupPreview | null>(null);
  /** 生成当前 `preview` 所用的参数指纹；与当前参数不符即表示预览已过期。 */
  const [previewKey, setPreviewKey] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  // 防止已被后续请求取代的旧预览结果覆盖新结果
  const reqIdRef = useRef(0);

  /** 当前条件集。预览用它取数，确认时只拿它做审计记录（删哪些看 `victims`）。 */
  const buildArgs = useCallback(
    () => ({
      mode,
      days: mode === "olderThanDays" ? days : null,
      targetMb: mode === "toTotalMb" ? targetMb : null,
      keepLastOne,
    }),
    [mode, days, targetMb, keepLastOne],
  );
  const argsKey = JSON.stringify(buildArgs());

  const runPreview = useCallback(async () => {
    const id = ++reqIdRef.current;
    const key = JSON.stringify(buildArgs());
    setPreviewing(true);
    setError("");
    try {
      const r = await invoke<BackupCleanupPreview>("preview_backup_cleanup", buildArgs());
      if (id !== reqIdRef.current) return;
      setPreview(r);
      setPreviewKey(key);
    } catch (e) {
      if (id !== reqIdRef.current) return;
      setPreview(null);
      setPreviewKey("");
      setError(String(e));
    } finally {
      if (id === reqIdRef.current) setPreviewing(false);
    }
  }, [buildArgs]);

  // 条件变化即重算（去抖 300ms，避免自定义输入框每敲一位打一次 IPC）。
  // 同步把 previewing 置 true，让去抖窗口内就能看出“正在重算”。
  useEffect(() => {
    if (!open) return;
    setPreviewing(true);
    const t = setTimeout(runPreview, 300);
    return () => clearTimeout(t);
  }, [open, runPreview]);

  // 关闭时把预览清干净。本组件由 FileControlCard 常驻渲染（只切 open），
  // 不清的话重新打开会先满不透明地闪一下上次的旧数字（刚清理完时尤其误导）。
  // 同时 bump reqId，让关闭后迟到的预览响应彻底作废。
  useEffect(() => {
    if (open) return;
    reqIdRef.current++;
    setPreview(null);
    setPreviewKey("");
    setPreviewing(false);
    setError("");
  }, [open]);

  const handleConfirm = async () => {
    if (!preview) return;
    setRunning(true);
    try {
      const r = await invoke<BackupCleanupResult>("cleanup_backups", {
        ...buildArgs(),
        // 只删用户刚看到并确认过的那一份清单
        victims: preview.victims,
      });
      const healed = r.healedIndexRows > 0 ? `，修复 ${r.healedIndexRows} 条孤儿索引` : "";
      const failed = r.failed > 0 ? `；${r.failed} 个删失败（可能被占用或只读）` : "";
      toast(
        `已删除 ${r.removed} 个备份，释放 ${formatBytes(r.freedBytes)}${healed}${failed}`,
        r.failed > 0 ? "error" : "success",
      );
      onDone();
      onClose();
      return;
    } catch (e) {
      toast(`清理失败：${e}`, "error");
    }
    setRunning(false);
  };

  const losingCount = preview?.filesLosingAll.length ?? 0;
  const stale = !preview || previewKey !== argsKey;

  return (
    <Modal open={open} onClose={onClose} className="w-full max-w-lg rounded-xl modal-surface">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <span className="title-chip">
          <Icon name="trash" size={15} />
        </span>
        <h3 className="text-sm font-semibold">清理备份</h3>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="关闭"
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4">
        <div className="text-[11px] text-muted-foreground">清理方式</div>
        <div className="flex flex-wrap gap-1.5">
          <OptionChip on={mode === "olderThanDays"} onClick={() => setMode("olderThanDays")}>
            按时间
          </OptionChip>
          <OptionChip on={mode === "toTotalMb"} onClick={() => setMode("toTotalMb")}>
            按体积
          </OptionChip>
          <OptionChip on={mode === "all"} onClick={() => setMode("all")}>
            全部清空
          </OptionChip>
        </div>

        {mode === "olderThanDays" && (
          <>
            <div className="text-[11px] text-muted-foreground">删除早于</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {DAY_PRESETS.map((d) => (
                <OptionChip
                  key={d}
                  on={!customDay && days === d}
                  onClick={() => {
                    setCustomDay(false);
                    setDays(d);
                  }}
                >
                  {d} 天
                </OptionChip>
              ))}
              <OptionChip on={customDay} onClick={() => setCustomDay(true)}>
                自定义…
              </OptionChip>
              {customDay && <NumBox value={days} min={1} unit="天" onCommit={setDays} />}
            </div>
          </>
        )}

        {mode === "toTotalMb" && (
          <>
            <div className="text-[11px] text-muted-foreground">清到目标大小以下</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {MB_PRESETS.map((mb) => (
                <OptionChip
                  key={mb}
                  on={!customMb && targetMb === mb}
                  onClick={() => {
                    setCustomMb(false);
                    setTargetMb(mb);
                  }}
                >
                  {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                </OptionChip>
              ))}
              <OptionChip on={customMb} onClick={() => setCustomMb(true)}>
                自定义…
              </OptionChip>
              {/* min=1：目标 0 等于全删，但用户以为自己在「清到 300MB」。
                  想全删必须显式选「全部清空」（后端也会拒）。 */}
              {customMb && <NumBox value={targetMb} min={1} unit="MB" onCommit={setTargetMb} />}
            </div>
            <p className="text-[11px] text-muted-foreground">
              最旧优先删，直到降到目标以下。同样受下面的保留底线约束。
            </p>
          </>
        )}

        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">至少保留每个文件最近 1 份</div>
            <div className="text-[11px] text-muted-foreground">
              开着时即使某文件所有备份都超期，也会给它留最新一份；关掉后才可能删光
            </div>
          </div>
          <Switch
            checked={keepLastOne}
            onChange={setKeepLastOne}
            variant={keepLastOne ? "default" : "danger"}
            ariaLabel="至少保留每个文件最近 1 份"
          />
        </div>

        <BackupCleanupPreviewPanel
          preview={preview}
          previewing={previewing}
          stale={stale}
          error={error}
        />
      </div>

      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button variant="outline" size="sm" onClick={onClose}>
          取消
        </Button>
        {!keepLastOne && losingCount > 0 && (
          <Button variant="outline" size="sm" onClick={() => setKeepLastOne(true)}>
            开启底线重算
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          className="ml-auto"
          // stale 涵盖了「还没预览」与「预览已过期」两种情况
          disabled={stale || previewing || preview.count === 0}
          isLoading={running}
          loadingText="清理中..."
          onClick={handleConfirm}
        >
          {stale ? "确认删除" : `确认删除 ${preview.count} 个`}
        </Button>
      </div>
    </Modal>
  );
}
