import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "../../../ui/card";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { ToggleRow } from "../../../ui/ToggleRow";
import { ConfirmModal } from "../../../ui/ConfirmModal";
import { useMcpBridge } from "./useMcpBridge";
import { ServerRow } from "./ServerRow";
import { ImportWizard } from "./ImportWizard";
import { EnableRiskModal } from "./EnableRiskModal";
import { ServerEditModal } from "./ServerEditModal";
import { RemoteCwdRiskModal } from "./RemoteCwdRiskModal";
import type { StaticStatus } from "../../../../lib/types";
import type { McpBridgeServer, ServerInput } from "./types";

/**
 * 「外挂 MCP 桥」设置卡（设计稿：`design/外挂MCP桥-设置页UI-设计稿.html` 方案 A）。
 *
 * 🔴 **这张卡跟设置页其它卡不是一类东西**。其它开关调的是 cc-bridge 自己的边界
 * （白名单 / 只读 / 限流）；这张卡是把边界外的能力接进来。启用一条 `filesystem`
 * 就等于把它参数里那个目录交给远程，而路径白名单对它零约束力。
 *
 * 插在安全卡之后：设置页按「风险 + 改动频率」排序，而它的风险不低于「命令执行」
 * （命令执行还有三道闸，桥接的 spawn 一道都不走）。
 */
export function McpBridgeGroup({ status }: { status?: StaticStatus }) {
  const bridge = useMcpBridge();
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<McpBridgeServer | "new" | null>(null);
  const [confirmEnable, setConfirmEnable] = useState<McpBridgeServer | null>(null);
  const [confirmSave, setConfirmSave] = useState<ServerInput | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<McpBridgeServer | null>(null);
  const [confirmRemoteCwd, setConfirmRemoteCwd] = useState<McpBridgeServer | null>(null);

  const master = bridge.data?.enabled ?? false;
  const servers = bridge.data?.servers ?? [];
  const onCount = servers.filter((s) => s.enabled).length;

  return (
    <Card id="set-mcpbridge">
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle icon={<Icon name="plug" />}>
          外挂 MCP 桥
          <span
            className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-normal ${
              master && onCount ? "bg-destructive/12 text-destructive" : "bg-muted text-muted-foreground"
            }`}
          >
            {!master ? "未启用" : onCount ? `${onCount} 个已启用` : "已开启 · 无生效项"}
          </span>
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
          <Icon name="download" size={13} />
          导入
        </Button>
      </CardHeader>

      <CardContent className="space-y-0">
        <ToggleRow
          id="toggle-external-mcp"
          label="启用外挂 MCP 桥"
          danger={master}
          variant="danger"
          sub={
            master
              ? "⚠ 已开启 · 远程可调用下方已勾选的 server，它们不受路径白名单约束"
              : "把本机已装的 MCP server 转给远程 Claude Code 使用。默认关闭。"
          }
          checked={master}
          onChange={(v) => void bridge.setMaster(v)}
          last
        />

        {/* 总开关关、但已有勾选项时要说清楚「现在不生效」，
            否则用户会以为那几个开着的开关就是生效的。 */}
        {!master && onCount > 0 && (
          <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
            总开关关闭中 · 下方 {onCount} 个已勾选的 server <b>当前不生效</b>，远程调用会直接被拒。
          </div>
        )}

        <div className="mt-3">
          {servers.length === 0 ? (
            <div className="rounded-lg bg-primary/8 px-3 py-2 text-[11.5px] text-primary">
              尚未配置任何 server。可从 <code className="font-mono">~/.claude.json</code> 等已有配置一键导入，
              导入后均保持关闭。
            </div>
          ) : (
            servers.map((s) => (
              <ServerRow
                key={s.name}
                server={s}
                master={master}
                busy={bridge.busy === s.name}
                // 开→需二次确认（S1）；关→直接执行，收紧边界不需要摩擦。
                onToggle={(next) =>
                  next ? setConfirmEnable(s) : void bridge.setEnabled(s.name, false)
                }
                onProbe={() => void bridge.probe(s.name)}
                onEdit={() => setEditing(s)}
                onRemove={() => setConfirmRemove(s)}
                // 开→二次确认（这是放宽边界）；关→直接执行，收回权限不需要摩擦。
                onToggleRemoteCwd={(next) =>
                  next ? setConfirmRemoteCwd(s) : void bridge.setRemoteCwd(s.name, false)
                }
              />
            ))
          )}
        </div>

        <Button variant="outline" size="sm" className="mt-1" onClick={() => setEditing("new")}>
          <Icon name="plus" size={13} />
          手动添加
        </Button>
      </CardContent>

      {importing && (
        <ImportWizard
          master={master}
          onCancel={() => setImporting(false)}
          onImport={bridge.importSelected}
        />
      )}

      {editing && (
        <ServerEditModal
          initial={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(null)}
          // 不直接保存：改 command / args 与启用在实效上是一回事，同级确认（S1）。
          onSubmit={(input) => {
            setEditing(null);
            setConfirmSave(input);
          }}
        />
      )}

      {confirmEnable && (
        <EnableRiskModal
          mode="enable"
          name={confirmEnable.name}
          command={confirmEnable.command}
          args={confirmEnable.args}
          envKeys={confirmEnable.envKeys}
          effectiveCwd={confirmEnable.cwd ?? confirmEnable.effectiveCwd}
          tools={confirmEnable.tools}
          instructions={confirmEnable.instructions}
          onCancel={() => setConfirmEnable(null)}
          onConfirm={() => {
            void bridge.setEnabled(confirmEnable.name, true);
            setConfirmEnable(null);
          }}
        />
      )}

      {confirmSave && (
        <EnableRiskModal
          mode="save"
          name={confirmSave.name}
          command={confirmSave.command}
          args={confirmSave.args}
          envKeys={(confirmSave.env ?? []).map(([k]) => k)}
          effectiveCwd={confirmSave.cwd}
          onCancel={() => setConfirmSave(null)}
          onConfirm={() => {
            void bridge.upsert(confirmSave);
            setConfirmSave(null);
          }}
        />
      )}

      {confirmRemoteCwd && (
        <RemoteCwdRiskModal
          name={confirmRemoteCwd.name}
          currentCwd={
            confirmRemoteCwd.cwd ||
            confirmRemoteCwd.effectiveCwd ||
            "cc-bridge 自己的工作目录"
          }
          allowedRoots={status?.allowedRoots ?? []}
          whitelistEnabled={status?.whitelistEnabled ?? true}
          onCancel={() => setConfirmRemoteCwd(null)}
          onConfirm={() => {
            void bridge.setRemoteCwd(confirmRemoteCwd.name, true);
            setConfirmRemoteCwd(null);
          }}
        />
      )}

      {confirmRemove && (
        <ConfirmModal open onClose={() => setConfirmRemove(null)} maxWidth="sm">
          <h4 className="mb-2 text-base font-semibold">删除「{confirmRemove.name}」？</h4>
          <p className="mb-4 text-sm text-muted-foreground">
            只删这条配置与它的工具清单缓存，<b>不会卸载</b>那个程序本身。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmRemove(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                void bridge.remove(confirmRemove.name);
                setConfirmRemove(null);
              }}
            >
              删除
            </Button>
          </div>
        </ConfirmModal>
      )}
    </Card>
  );
}
