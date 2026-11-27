import { useLayoutEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Collapse } from "../ui/Collapse";
import type { OverwritePrompt, TransferState } from "../../lib/transferTypes";

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
    // 传输条同样落在终端画布上：`bg-muted/40` 半透明会被深色画布吃成中灰，
    // 文件名与进度文字（muted-foreground）几乎看不见 —— 改用不透明 bg-muted。
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-3 border-y border-border bg-muted px-3 py-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Icon name={transfer.kind === "up" ? "upload" : "download"} size={12} />
      </span>
      {transfer.total != null && transfer.total > 1 && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {transfer.index}/{transfer.total}
        </span>
      )}
      <span className="min-w-0 max-w-[190px] flex-1 truncate text-xs" title={transfer.name}>
        {transfer.name}
      </span>
      <span role="progressbar" aria-label={transfer.kind === "down" ? "下载进度" : "上传进度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-border">
        {pct == null ? (
          <span className="block h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
        ) : (
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        )}
      </span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {pct == null ? "连接中…" : eta ? `${pct}% 剩余 ${eta}` : `${pct}%`}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-9 shrink-0 whitespace-nowrap px-3 text-xs text-destructive-ink hover:bg-destructive/10"
        onClick={onCancel}
      >
        {transfer.kind === "down" ? "取消下载" : "取消上传"}
      </Button>
    </div>
  );
}

/**
 * 传输条槽位（2026-10-17）：传输条出现/消失从「硬切推挤文件列表」变成 200ms
 * 平滑展开/收起（Collapse 行槽位 0fr→1fr）。退场期间保留最后一次传输快照渲染
 * （held），收起动画不播空气。
 *
 * 🔴 只给**文件浏览器挂载点**用（SshFileBrowser）：那块推的是文件列表，没有终端
 * fit 约束。终端 pane 上方的挂载点（TerminalDropLayer）**保持硬切**——动画高度
 * 会让 xterm 在 200ms 里连续重跑 fit，一次硬切只 fit 一次反而是对的（§七红线）。
 */
export function TransferBarSlot({
  transfer,
  onCancel,
}: {
  transfer: TransferState | null;
  onCancel: () => void;
}) {
  const [held, setHeld] = useState<TransferState | null>(null);
  useLayoutEffect(() => {
    if (transfer) setHeld(transfer);
  }, [transfer]);
  const shown = transfer ?? held;
  return (
    <Collapse open={!!transfer}>
      {shown && <TransferBar transfer={shown} onCancel={onCancel} />}
    </Collapse>
  );
}

/**
 * 覆盖确认。
 *
 * 现状是删除有二次确认、覆盖却静默执行——两者丢数据的后果是一样的。
 * 下载方向额外说明临时文件机制，让用户知道取消不会毁掉原文件。
 *
 * 批量上传同名时**一次问完**（`names` 多于一个）：原来每个同名文件各弹一次，
 * 拖 5 个同名文件要点 5 次确认。这里给「跳过同名」作为第三个出口。
 */
export function OverwriteConfirmDialog({
  prompt,
  onCancel,
}: {
  prompt: OverwritePrompt | null;
  onCancel: () => void;
}) {
  const up = prompt?.kind === "up";
  const names = prompt?.names ?? [];
  const total = prompt?.total;
  return (
    <Dialog open={!!prompt} ariaLabel="处理同名文件" onClose={onCancel}>
      <DialogHeader><DialogTitle>处理同名文件</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">
        {total ? <strong>{total} 个文件中，{names.length} 个同名。</strong> : up ? "远端已存在同名文件。" : "本机已存在同名文件。"}
      </p>
      <code className="mt-2 block break-all rounded-md bg-muted p-2 text-xs">{prompt?.path}</code>
      <ul className="mt-2 max-h-40 overflow-auto divide-y divide-border text-sm">
        {names.map(name => <li key={name} className="flex items-center gap-2 break-all py-2"><Icon name="file" size={14} className="shrink-0"/>{name}</li>)}
      </ul>
      {total != null && total > names.length && <p className="mt-2 text-xs text-muted-foreground">其余文件照常传输。</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        {prompt?.skip && <Button size="sm" variant="outline" onClick={prompt.skip}>跳过同名项</Button>}
        {prompt?.keepBoth && <Button size="sm" onClick={prompt.keepBoth}>保留两份</Button>}
        <Button size="sm" variant="outline" onClick={() => prompt?.confirm()}>替换 {names.length} 项</Button>
      </div>
    </Dialog>
  );
}
