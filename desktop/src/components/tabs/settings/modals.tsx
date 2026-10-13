import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ConfirmModal } from "../../ui/ConfirmModal";

/**
 * 设置页弹窗收纳。
 *
 * 2026-10-13（去重统一）：WhitelistOffModal / ShellRiskModal 已删除——三个核心开关
 * （白名单 / 只读 / 命令执行）的唯一家是安全页，其二次确认统一为 SecurityOverview
 * 内联的 ConfirmDialog 实现（焦点陷阱 + Esc + 焦点归还）。设置页安全卡瘦身后
 * 不再触发这两个弹窗；ResetModal 保留（重置覆盖多张卡，仍属设置页职责）。
 */
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
        <Icon name="alertTriangle" size={18} className="text-warning-ink" />
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
