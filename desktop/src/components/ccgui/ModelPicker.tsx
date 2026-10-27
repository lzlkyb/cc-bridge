import { useEffect, useRef, useState, type RefObject } from "react";
import { isOutsideDismiss } from "../../lib/utils";
import { useAnchoredPopover } from "../../hooks/useAnchoredPopover";
import { Icon } from "../ui/icon";

/**
 * 模型选择浮层。
 *
 * ## 为什么值得一个浮层而不是设置页里的下拉
 *
 * 「这轮用 Opus 还是 Sonnet」是**每轮都可能改的决策**（长任务要Opus、刷小活用Haiku），
 * 放在设置页等于逼用户为一条命令翻四级菜单。它和权限模式是同一类东西：
 * 本轮参数，不是应用配置。
 *
 * ## 为什么有「自定义」
 *
 * CLI 的模型名随版本漂移（`opus` / `claude-opus-4-5` / 中转站的自定义名都合法），
 * 写死一份预设列表等于每次 CLI 升级都要发版。预设只是快捷方式，
 * 真正的入口是那个输入框 —— 里面存的值原样传给 `--model`。
 *
 * 空值 = 不传 `--model`，吃 CLI 自己的默认（可能是用户 settings 里设的那个）。
 * 🔴 所以「默认」不是某个具体模型，恢复选项必须存在，不能只给一个空输入框。
 */
const PRESETS: { value: string; label: string; hint: string }[] = [
  { value: "", label: "默认模型", hint: "不传 --model，跟随 CLI 自己的配置" },
  { value: "opus", label: "Opus", hint: "最难的任务：架构、排查、长链路重构" },
  { value: "sonnet", label: "Sonnet", hint: "日常主力：均衡" },
  { value: "haiku", label: "Haiku", hint: "最快最便宜：小改动、批量杂务" },
  { value: "opusplan", label: "Opus Plan", hint: "先出计划再执行，适合大改动前评审" },
];

export function ModelPicker({
  value,
  onChange,
  onClose,
  anchorRef,
}: {
  value: string;
  onChange: (model: string) => void;
  onClose: () => void;
  /** 触发按钮的容器（会话条里那个 `span`）。浮层按它的 rect 定位，见 hook 头注。 */
  anchorRef: RefObject<HTMLElement>;
}) {
  const [draft, setDraft] = useState(value);
  const boxRef = useRef<HTMLDivElement>(null);
  // 🔴 不能用 `absolute right-0`：会话条一换行，锚点就跑到 pane 左端，
  // 浮层左半边会被 `data-cc-panel` 的 `overflow-hidden` 切掉（`Opus Plan`
  // 显示成 `s Plan`）。详见 `useAnchoredPopover`。
  const style = useAnchoredPopover(anchorRef, true, { width: 260 });

  // 点外面关 + Esc 关。`pointerdown` Capture：按下的那一刻就收。
  // 开关按钮自身不算外点（`isOutsideDismiss` 的理由写在那边）。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (isOutsideDismiss(e, boxRef.current, "model")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="选择模型"
      style={style}
      className="z-30 flex flex-col overflow-y-auto rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-foreground">模型</span>
        <p className="mt-[2px] text-[11px] leading-[1.5] text-muted-foreground">
          下一轮生效。已在跑的一轮不换模型（CLI 不支持运行中切换）。
        </p>
      </div>
      <div className="flex flex-col p-1">
        {PRESETS.map((p) => {
          const on = value === p.value;
          return (
            <button
              key={p.value || "default"}
              type="button"
              onClick={() => {
                onChange(p.value);
                onClose();
              }}
              className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                on ? "bg-primary/10" : "hover:bg-muted/60"
              }`}
            >
              <Icon
                name="check"
                size={11}
                className={`mt-[3px] shrink-0 ${on ? "text-primary" : "opacity-0"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium text-foreground">{p.label}</span>
                <span className="block text-[11px] leading-[1.4] text-muted-foreground">{p.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <form
        className="flex items-center gap-1.5 border-t border-border px-2 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          onChange(draft.trim());
          onClose();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="自定义模型名…"
          aria-label="自定义模型名"
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          用这个
        </button>
      </form>
    </div>
  );
}
