import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { TUI_FULLSCREEN_CMD } from "../../lib/terminalTuiGuide";
import type { WheelPopStep } from "../../hooks/useWheelGuide";

interface Props {
  sessionId: string;
  /** 打开时的初始步骤：⚠ 死滚轮徽章走 info，引导条「一键切换」直达 confirm。 */
  initialStep: WheelPopStep;
  /** 发送成功回调（记录 sentAt、压掉引导）。 */
  onSent: () => void;
  onClose: () => void;
}

/**
 * 滚轮救急面板 + 发送确认（设计稿屏2/屏3）。
 *
 * - info 步：解释「为什么死了」（备用屏 × 未开鼠标跟踪），给 PgUp/PgDn 救急键，
 *   并提供「发送 /tui fullscreen」入口。
 * - confirm 步：发送前轻量确认——往用户远端会话打字属于高侵入动作，决策权留给用户
 *   （绝不自动发）。按钮即确认，不再套第二层弹窗。
 *
 * 发送 = 经 `ssh_input` 原样键入并回车（等同手敲）。失败（会话已断开）走 error toast。
 * Esc / 点外部关闭；定位由父级容器（终端画布右上角）负责。
 *
 * 已知边界（排查结论，接受）：发送前提是「死滚轮 = 备用屏里还有活着的程序」，但若
 * 程序恰在徽章渲染与点击之间退出、裸 bash 回到提示符，这条命令会被 bash 执行并
 * 报 command not found、进 history。不加前导空格规避（HISTCONTROL=ignoreboth）：
 * Claude Code 侧对行首空格的 slash 解析行为未验证，不能为罕见边界赌主路径。
 */
export function WheelOwnerPopover({ sessionId, initialStep, onSent, onClose }: Props) {
  const [step, setStep] = useState<WheelPopStep>(initialStep);
  const ref = useRef<HTMLDivElement>(null);

  // Esc / 点外部关闭。capture 阶段监听 mousedown：面板外是终端画布，事件不会冒泡进来。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  const send = () => {
    invoke("ssh_input", { sessionId, data: TUI_FULLSCREEN_CMD })
      .then(() => {
        onSent();
        toast("已发送 /tui fullscreen · Claude Code 重启后滚轮将固定转发", "success");
      })
      .catch(() => toast("发送失败：会话已断开", "error"));
    onClose();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="滚轮救急面板"
      className="absolute right-3 top-3 z-30 w-[330px] rounded-xl border bg-card p-3.5 text-[12.5px] leading-relaxed shadow-pop"
    >
      {step === "info" ? (
        <>
          <p className="flex items-center gap-1.5 font-semibold">
            <span aria-hidden className="rounded-full bg-warning/[0.14] px-1.5 text-warning-ink">⚠</span>
            滚轮此刻不可用
          </p>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            终端处于备用屏，但程序未开启鼠标跟踪——滚轮无处可去。常见于 Claude Code
            后台会话（claude attach）的上游缺陷，或全屏程序切换的瞬间。
          </p>
          <p className="mt-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
            现在可用的滚动方式：
            <Kbd>PgUp</Kbd> / <Kbd>PgDn</Kbd> 半页 · <Kbd>Ctrl+Home</Kbd>/<Kbd>Ctrl+End</Kbd> 跳头尾
          </p>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            若这是 Claude Code 会话，发一次 <b>/tui fullscreen</b>{" "}
            可让它接管鼠标跟踪（同时消除滚轮归属翻转）：
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStep("confirm")}
              className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              发送 /tui fullscreen
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-muted"
            >
              知道了
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="font-semibold">向终端发送命令？</p>
          <p className="mt-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
            将键入并回车：<b className="text-primary">/tui fullscreen</b>
            <br />
            <span className="text-muted-foreground">经 ssh_input 原样发给远端（等同手敲）。</span>
          </p>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            发送前请确认：① Claude Code 输入框是空的（有草稿会拼接）；② 正在生成中也可以发，
            文本会进入输入框排队。发送后 Claude Code 会自动重启进 fullscreen，对话不丢。
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={send}
              className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              发送
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-muted"
            >
              取消
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 键帽样式（面板内的小 kbd）。 */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border border-b-2 bg-background px-1.5 py-px font-mono text-[11px]">
      {children}
    </kbd>
  );
}
