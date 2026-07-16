import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";

/** 步骤序号圆点：done 时显示对勾 */
export function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${done ? "step-num--done" : ""}`}
    >
      {done ? "✓" : n}
    </span>
  );
}

/** 接入作用域选择卡（项目级 / 全局模式），选中态强化 */
export function OptionCard({
  selected,
  title,
  desc,
  badge,
  onClick,
}: {
  selected: boolean;
  title: string;
  desc: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative rounded-lg border-2 p-3 text-left transition-colors ${
        selected
          ? "border-primary bg-accent shadow-ring-focus"
          : "border-transparent bg-muted/50 hover:bg-muted"
      }`}
    >
      {selected && (
        <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Icon name="check" size={12} />
        </span>
      )}
      <div className="mb-1 flex items-center gap-2">
        <span className={`text-sm font-medium ${selected ? "text-primary" : ""}`}>{title}</span>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </button>
  );
}

/** 终端风格命令块：命令 + 复制按钮 */
export function CommandBlock({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="code-box flex items-start gap-2">
      <span className="mt-[1px] shrink-0 font-mono text-xs font-semibold text-primary/30">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
        {command || "加载中..."}
      </code>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onCopy} disabled={!command}>
        <Icon name={copied ? "check" : "copy"} size={14} />
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}
