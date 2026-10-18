import { useState } from "react";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { ConfirmModal } from "../../../ui/ConfirmModal";
import { fullCommand, type McpBridgeServer } from "./types";

/**
 * 总开关的风险确认（S1 补齐）。
 *
 * 🔴 **门槛不能倒挂**：单条 server 启用要过 `EnableRiskModal`，而功能风险最高的
 * 总开关原本一键生效——它是唯一能一次性把**下面所有勾选项**全部放开的东西。
 *
 * 这里不逐条展示每个 server 的完整工具清单（那是 `EnableRiskModal` 的事，
 * 单条启用时已经确认过），只回答一个问题：**这一下会把哪些进程同时变成可达**。
 */
export function MasterRiskModal({
  servers,
  onCancel,
  onConfirm,
}: {
  /** 总开关开启后会立刻生效的那些 server。空数组也要能弹（说明「开了但没人可用」）。 */
  servers: McpBridgeServer[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [ack, setAck] = useState(false);

  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-3 flex items-center gap-2 text-base font-semibold text-destructive-ink">
        <Icon name="alertTriangle" size={18} />
        开启外挂 MCP 桥？
      </h4>

      {servers.length === 0 ? (
        <div className="mb-3 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
          当前没有勾选任何 server，<b>开启后远程仍然调用不到东西</b>。
          <br />
          需要再逐条勾选下方列表里的 server 才会真正放开。
        </div>
      ) : (
        <>
          <p className="mb-1.5 text-xs text-muted-foreground">
            以下 <b>{servers.length}</b> 个 server 将<strong>同时</strong>对远程可达：
          </p>
          {/* 逐字展示命令行，不高亮片段（同 `EnableRiskModal` 的 S0/S5 理由）。 */}
          <div className="mb-2 space-y-1 rounded-lg bg-muted px-3 py-2">
            {servers.map((s) => (
              <div key={s.name} className="break-all font-mono text-[11.5px] leading-relaxed">
                <span className="text-foreground">{s.name}</span>
                <span className="text-muted-foreground"> · {fullCommand(s.command, s.args)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mb-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive-ink">
        <div className="mb-1.5 font-semibold">开启后会发生什么：</div>
        <div className="mb-1">① 远程 AI 工具立刻可以调用上面这些 server 的全部已暴露工具。</div>
        <div className="mb-1">
          ② 它们的进程<b>不走 cc-bridge 的路径白名单</b>，能碰到什么由各自参数决定。
        </div>
        <div>③ 审计只记录转发了什么；进程内部的读写 cc-bridge 看不见。</div>
      </div>

      <label className="mb-4 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        我已确认要开启，并知道上面这些 server 会同时对远程可用
      </label>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" disabled={!ack} onClick={onConfirm}>
          开启
        </Button>
      </div>
    </ConfirmModal>
  );
}
