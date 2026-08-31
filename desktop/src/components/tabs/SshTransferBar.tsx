import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import type { OverwritePrompt, TransferState } from "./useSshTransfer";

/** 把剩余秒数格成 `mm:ss`。超过一小时就不报了——那个量级的估值没有参考价值。 */
function fmtEta(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0 || sec > 3600) return null;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 传输中的进度条（文件头下方）。
 *
 * 一次只允许一个传输（沿用现有 `busy` 模型），所以只需一条，不做任务列表。
 * `percent` 为 null 时退化成不定量条（握手/认证阶段 scp 还没开始刷进度）。
 */
export function TransferBar({
  transfer,
  onCancel,
}: {
  transfer: TransferState;
  onCancel: () => void;
}) {
  const eta = fmtEta(transfer.eta);
  const pct = transfer.percent;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/40 px-3 py-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Icon name={transfer.kind === "up" ? "upload" : "download"} size={12} />
      </span>
      <span className="max-w-[190px] truncate text-xs" title={transfer.name}>
        {transfer.name}
      </span>
      <span className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-border">
        {pct == null ? (
          <span className="block h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
        ) : (
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        )}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {pct == null ? "连接中…" : eta ? `${pct}% 剩余 ${eta}` : `${pct}%`}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 px-3 text-xs text-destructive hover:bg-destructive/10"
        onClick={onCancel}
      >
        取消
      </Button>
    </div>
  );
}

/**
 * 覆盖确认。
 *
 * 现状是删除有二次确认、覆盖却静默执行——两者丢数据的后果是一样的。
 * 下载方向额外说明临时文件机制，让用户知道取消不会毁掉原文件。
 */
export function OverwriteConfirmDialog({
  prompt,
  onCancel,
}: {
  prompt: OverwritePrompt | null;
  onCancel: () => void;
}) {
  const up = prompt?.kind === "up";
  return (
    <Dialog open={!!prompt} onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>{up ? "远端已存在同名文件" : "本机已存在同名文件"}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        {up ? "继续上传将覆盖远端文件。" : "继续下载将覆盖该文件，原内容无法恢复。"}
      </p>
      <code className="mt-2 block break-all rounded-md border border-border bg-muted px-2.5 py-2 text-xs text-foreground">
        {prompt?.path}
      </code>
      {!up && (
        <p className="mt-2 text-xs text-muted-foreground">
          下载会先写临时文件，传完才替换；中途取消不会动原文件。
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button onClick={() => prompt?.confirm()}>覆盖</Button>
      </div>
    </Dialog>
  );
}
