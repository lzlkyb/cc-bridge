import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ConfirmModal } from "../../ui/ConfirmModal";

export function WhitelistOffModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
        <Icon name="alertTriangle" size={18} />
        确定关闭路径白名单？
      </h4>
      <p className="mb-4 text-sm text-muted-foreground">
        关闭后远程 Claude Code 可读写本机<b>全部文件</b>，风险显著上升。
        请确认你正处于完全可信的网络环境，用完及时开回。
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          确定关闭
        </Button>
      </div>
    </ConfirmModal>
  );
}

export function ShellRiskModal({
  readonly,
  ackRisk,
  onAckChange,
  onCancel,
  onConfirm,
}: {
  readonly: boolean;
  ackRisk: boolean;
  onAckChange: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
        <Icon name="alertTriangle" size={18} />
        确定开启命令执行？
      </h4>
      {/* fix #3：只读模式与命令执行互斥的主动提示 */}
      {readonly && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
          <span>
            当前<b>只读模式已开启</b>，命令执行会被<b>强制禁止</b>而不会生效。如需真正启用，请先在上方关闭只读模式。
          </span>
        </div>
      )}
      <p className="mb-3 text-sm text-muted-foreground">
        开启后远程 Claude Code 可在白名单目录内执行<b>任意 Shell 命令</b>，包括但不限于安装软件、
        修改系统设置、访问网络。这等同于授予<b>远程任意代码执行权限（RCE）</b>。
      </p>
      <ul className="mb-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>路径白名单 / 扩展名限制等约束可被命令绕过</li>
        <li>Bearer token 鉴权 + 限流是唯一准入防线</li>
        <li>每条命令都会被强制记入审计日志</li>
      </ul>
      <label className="mb-4 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={ackRisk}
          onChange={(e) => onAckChange(e.target.checked)}
        />
        我已知晓风险，仅在完全可信的网络环境中开启
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" disabled={!ackRisk} onClick={onConfirm}>
          确定开启
        </Button>
      </div>
    </ConfirmModal>
  );
}

export function ResetModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal open onClose={onCancel} maxWidth="sm">
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <Icon name="alertTriangle" size={18} className="text-warning" />
        重置功能开关为默认？
      </h4>
      <p className="mb-4 text-sm text-muted-foreground">
        这将把白名单校验、审计日志、备份、限流重新开启，只读模式、编码自适应、命令执行关闭。
        当前的白名单目录、扩展名等其他设置不会受影响。
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="default" size="sm" onClick={onConfirm}>
          重置为默认
        </Button>
      </div>
    </ConfirmModal>
  );
}
