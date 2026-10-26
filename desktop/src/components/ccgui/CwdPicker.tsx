import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { isOutsideDismiss } from "../../lib/utils";
import { Icon } from "../ui/icon";

/**
 * 工作目录浮层（会话条上的目录 chip 点开）。
 *
 * 语义是「这条会话在哪个目录里跑」—— 它此前只在**空状态**里能改，一旦说了第一句话
 * 就只剩一个不可点的 chip。而「换项目」是随时可能发生的事：用户做完 A 项目顺手
 * 想接着弄 B，唯一的出路是关掉这条会话重开，对话上下文也跟着丢。
 *
 * 🔴 换目录的代价必须当面说：cwd 变了 `cc_start` 会判成「换了目标」→ 清 resume id
 *    → 下一句开一条**新会话**（模型忘光前面）。不说清楚的话，用户改完目录接着聊，
 *    会以为模型还记得，实际它已经在另一个上下文里从零开始。
 */
export function CwdPicker({
  value,
  isRemote,
  hasMessages,
  onChange,
  onClose,
}: {
  value: string;
  /** 远端目标：目录在**对方机器**上，本机的「选择文件夹」对它没有意义。 */
  isRemote: boolean;
  /** 这条会话已经说过话 ⇒ 换目录等于另起一条。 */
  hasMessages: boolean;
  onChange: (cwd: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [picking, setPicking] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外面关 + Esc 关（与 ModelPicker 同一条规矩：`pointerdown` 按下即收）。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (isOutsideDismiss(e, boxRef.current, "cwd")) onClose();
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

  const apply = (next: string) => {
    onChange(next.trim());
    onClose();
  };

  const browse = async () => {
    setPicking(true);
    try {
      const dir = await open({ directory: true, defaultPath: value || undefined });
      // 取消返回 null，多选返回数组 —— 这里只要一个字符串。
      if (typeof dir === "string") apply(dir);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="工作目录"
      className="absolute left-0 top-full z-30 mt-1 w-[320px] overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-foreground">工作目录</span>
        <p className="mt-[2px] text-[11px] leading-[1.5] text-muted-foreground">
          {isRemote ? "远端机器上的路径（留空 = 登录目录）" : "本机路径（留空 = 家目录）"}
        </p>
      </div>
      <div className="flex flex-col gap-2 p-2">
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply(draft);
              }
            }}
            spellCheck={false}
            aria-label="工作目录路径"
            placeholder={isRemote ? "留空 = 登录目录" : "留空 = 家目录"}
            className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
          />
          {!isRemote && (
            <button
              type="button"
              onClick={() => void browse()}
              disabled={picking}
              title="在本机选一个文件夹"
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
            >
              <Icon name="folder" size={11} />
              浏览…
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => apply(draft)}
            className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] text-primary transition-colors hover:bg-primary/15"
          >
            用这个目录
          </button>
          {value && (
            <button
              type="button"
              onClick={() => apply("")}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              恢复默认
            </button>
          )}
        </div>
        {hasMessages && (
          <p className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-warning-ink/90">
            <Icon name="alertTriangle" size={11} className="mt-[2px] shrink-0" />
            <span>
              换目录后下一句会开一条<strong className="font-semibold">新</strong>
              会话（模型看不到这段对话），原对话仍在历史里。
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
