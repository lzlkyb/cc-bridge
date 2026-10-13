import type { StaticStatus } from "../../../lib/types";
import { Icon } from "../../ui/icon";
import { InlineNum } from "../../ui/InlineNum";

/**
 * 「文件管控」卡的请求限流展开区（SumRow 折叠态之下）。
 *
 * 纯展示：数值经 saveField 落盘（父组件 FileControlCard 持有防抖与已保存反馈）。
 * InlineNum 全部带 ariaLabel——读屏报「请求次数上限」而非「数字输入框」。
 */
export function RateLimitSection({
  status,
  saveField,
  lastSavedField,
}: {
  status?: StaticStatus;
  saveField: (patch: Record<string, unknown>, fieldName: string) => Promise<void>;
  lastSavedField: string;
}) {
  return (
    <div className="space-y-2.5 px-2.5 pb-2">
      <div className="s-row group">
        <span className="title-chip"><Icon name="sliders" size={15} aria-hidden="true" /></span>
        <div className="s-body">
          <div className="s-label">请求限制</div>
          <div className="s-row-desc">
            当前：每 {status ? status.rateLimit.windowMs / 1000 : 60}s 最多 {status?.rateLimit.maxRequests ?? 100} 次，超出拒绝
          </div>
        </div>
        <div className="s-right">
          <InlineNum
            value={status?.rateLimit.maxRequests ?? 100}
            saved={lastSavedField === "rateMaxReq"}
            unit="次 /"
            ariaLabel="请求次数上限"
            onSave={(v) => saveField({ rateLimitMaxRequests: v }, "rateMaxReq")}
          />
          <InlineNum
            value={status ? status.rateLimit.windowMs / 1000 : 60}
            saved={lastSavedField === "rateWindow"}
            unit="秒"
            ariaLabel="统计窗口时长（秒）"
            onSave={(v) => saveField({ rateLimitWindowMs: v * 1000 }, "rateWindow")}
          />
        </div>
      </div>
    </div>
  );
}

/** 「后台命令」展开区：结束后保留时长一个数值。 */
export function CleanupSection({
  status,
  saveField,
  lastSavedField,
}: {
  status?: StaticStatus;
  saveField: (patch: Record<string, unknown>, fieldName: string) => Promise<void>;
  lastSavedField: string;
}) {
  return (
    <div className="space-y-2.5 px-2.5 pb-2">
      <div className="s-row group">
        <span className="title-chip"><Icon name="terminal" size={15} aria-hidden="true" /></span>
        <div className="s-body">
          <div className="s-label">结束后保留时长</div>
          <div className="s-row-desc">
            命令执行结束后在面板保留一段时间（供查看最终输出），超时自动清除。设为 0 则立即清除。
          </div>
        </div>
        <div className="s-right">
          <InlineNum
            value={status?.commandCleanupSecs ?? 120}
            saved={lastSavedField === "cleanupSecs"}
            unit="秒"
            ariaLabel="后台命令结束后保留时长（秒）"
            onSave={(v) => saveField({ commandCleanupSecs: v }, "cleanupSecs")}
          />
        </div>
      </div>
    </div>
  );
}
