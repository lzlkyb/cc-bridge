import { Icon } from "../../ui/icon";
import { Spinner } from "../../ui/Spinner";
import { SavedHint } from "../../ui/SavedHint";
import { shellTypeCopy } from "../../../lib/platform";

/* 命令执行壳层分段选择：cmd（默认）/ bash（Git Bash）。
 * 复用 ToggleRow 行布局（左标签+描述，右控件），控件为两按钮分段器而非开关。
 * bashAvailable=false 时 bash 按钮置灰（aria-disabled + 弱化样式），点击不触发保存，
 * 改为调用 onBashUnavailable（弹 toast），保持 shell_type 不变；并额外显示「刷新检测」按钮。
 *
 * 所有文案与**显示名**都来自 `shellTypeCopy(platform)`：存储值永远是 `cmd` / `bash`，
 * 但 Unix 上 `cmd` 实际跑的是 `/bin/sh`，显示成 cmd 会误导用户（见 lib/platform.ts）。 */
export function ShellTypeRow({
  platform,
  value,
  bashAvailable = true,
  onSelect,
  onBashUnavailable,
  onRefreshBash,
  refreshingBash = false,
  saved,
  last = false,
}: {
  platform?: string;
  value: string;
  bashAvailable?: boolean;
  onSelect: (next: "cmd" | "bash") => void;
  onBashUnavailable?: () => void;
  onRefreshBash?: () => void;
  refreshingBash?: boolean;
  saved?: boolean;
  last?: boolean;
}) {
  const copy = shellTypeCopy(platform);
  // key 是存储值（后端 ShellType 反序列化用），label 只是显示名，两者不能混。
  const options: { key: "cmd" | "bash"; label: string }[] = [
    { key: "cmd", label: copy.defaultLabel },
    { key: "bash", label: copy.altLabel },
  ];
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">命令执行壳层</span>
          {saved && <SavedHint>已保存</SavedHint>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          默认 <b>{copy.defaultLabel}</b>（{copy.defaultNote}）；选 <b>{copy.altLabel}</b> {copy.altNote}
        </div>
        {!bashAvailable && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-xs text-warning">{copy.unavailableWarn}</span>
            {onRefreshBash && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                onClick={onRefreshBash}
                disabled={refreshingBash}
              >
                {refreshingBash ? (
                  <>
                    <Spinner size={10} />
                    检测中…
                  </>
                ) : (
                  <>
                    <Icon name="refresh" size={11} />
                    刷新检测
                  </>
                )}
              </button>
            )}
            <span className="text-[11px] text-muted-foreground/60">安装后点击即生效，无需重启</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 rounded-lg border bg-muted p-0.5">
        {options.map((o) => {
          const active = value === o.key;
          const disabled = o.key === "bash" && !bashAvailable;
          return (
            <button
              key={o.key}
              type="button"
              aria-disabled={disabled}
              onClick={() => {
                if (disabled) {
                  onBashUnavailable?.();
                  return;
                }
                onSelect(o.key);
              }}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              } ${disabled ? "cursor-not-allowed opacity-40 hover:text-muted-foreground" : ""}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
