import { Icon } from "../../../ui/icon";
import { Spinner } from "../../../ui/Spinner";
import { ToolList } from "./ToolList";
import { fullCommand, type McpBridgeCandidate } from "./types";

/**
 * 可导入的一条候选。从 `ImportWizard` 拆出来（规则 7：`.tsx` ≤ 300 行）。
 *
 * 🔴 「运行一下」这个按钮会**真的执行上面那条命令**，而它没有二次确认框
 * （定稿：行里已经逐字展示了完整命令）。所以文案必须把“运行”放在最前，
 * **不能写成「查看详情」**——后者会让用户以为只是展开一段已有文字。
 */
export function CandidateRow({
  c,
  picked,
  running,
  masterOff,
  onToggle,
  onInspect,
}: {
  c: McpBridgeCandidate;
  picked: boolean;
  running: boolean;
  /** 总开关关着时不允许启子进程，与设置页「探测」按钮同一条规矩。 */
  masterOff: boolean;
  onToggle: () => void;
  onInspect: () => void;
}) {
  const tools = c.tools ?? [];
  const hasDetail = tools.length > 0 || !!c.instructions;

  return (
    <div
      className={`mb-1.5 rounded-lg border px-2.5 py-2 ${
        picked ? "border-primary/35 bg-primary/8" : ""
      }`}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={onToggle}
          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
            picked ? "border-primary bg-primary text-primary-foreground" : ""
          }`}
        >
          {picked && <Icon name="check" size={11} />}
        </button>

        <div className="min-w-0 flex-1">
          {/* 整块文字区也可点切换勾选，但不包含下面的按钮与工具清单。 */}
          <button type="button" onClick={onToggle} className="block w-full text-left">
            <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
              {c.name}
              {c.renamedFrom && (
                <span className="rounded-full bg-warning/14 px-2 py-0.5 text-[10px] font-normal text-warning">
                  已存在同名，导入为此名（原：{c.renamedFrom}）
                </span>
              )}
            </span>
            {/* 完整命令（S0）：`D:` 这种参数必须在勾选前就看得见。 */}
            <span className="mt-1 block break-all rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
              {fullCommand(c.command, c.args)}
            </span>
            {c.envKeys.length > 0 && (
              <span className="mt-1 block text-[11px] text-muted-foreground">
                环境变量：{c.envKeys.join("、")}
                <span className="ml-1.5 text-success">值已隐藏</span>
              </span>
            )}
          </button>

          {!hasDetail && (
            <button
              type="button"
              disabled={running || masterOff}
              onClick={onInspect}
              title={
                masterOff
                  ? "总开关关闭时不允许启动子进程"
                  : "会真的执行上面那条命令，拿到工具清单后立刻关掉"
              }
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] disabled:opacity-50"
            >
              {running ? <Spinner size={11} /> : <Icon name="play" size={11} />}
              {running ? "正在启动它…" : "运行一下，看它有哪些工具"}
            </button>
          )}

          {hasDetail && (
            <ToolList
              tools={tools}
              instructions={c.instructions}
              title={`${c.toolCount ?? tools.length} 个工具`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
