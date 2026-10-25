import { memo, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import {
  classifySlash,
  filterSlash,
  isSlashTyping,
  type SlashCommand,
} from "../../lib/ccSlash";
import { isImeComposing } from "../../lib/utils";
import { ComposerNotices } from "./ComposerNotices";
import { SlashPanel } from "./SlashPanel";

/** 输入区自动增高的高度上限（px）。约 8 行 13px 字：再高就该拆成文件了。 */
const MAX_TEXTAREA_H = 168;

/**
 * 输入区（接管 composer 位置，不弹模态）。
 *
 * 采用 dock 而非对话框的理由：审批/追问时用户往往要边看上面的 diff 边决定，
 * 模态会把这些上下文盖住。desktop-cc-gui 的 `QuestionCard` 也是这个做法。
 *
 * ## 运行中不再禁用发送
 *
 * 旧行为是 `disabled={running}`：用户被迫干等一轮跑完才能打字，而「趁着它跑的时候
 * 把下一句想好」是最自然的使用方式。现在运行中发送 = **排队**（`onSend` 收到后由
 * `useCcSession` 决定入队还是直发），队列在本组件里如实显示条数，可一键清空。
 *
 * 🔴 排队不是并发：后端 `cc_start` 在 `turn_active` 时直接报错，队列只在
 * 「本轮结束」的那一刻取下一条发出，任何时刻仍然只有一条消息在飞。
 *
 * ## slash 命令（白名单闸门）
 *
 * 值以 `/` 开头时浮出命令面板；发送前 `classifySlash` 判定：白名单内的
 * （/compact /clear /model）原样转发给 CLI 执行，其余一律拦住并提示去向 ——
 * 未知命令当提示词发给模型只会浪费一轮。判定与白名单在 `lib/ccSlash.ts`。
 */
function ComposerImpl({
  onSend,
  running,
  onInterrupt,
  placeholder,
  sendHint = "Ctrl+Enter",
  queueCount,
  onClearQueue,
  onPolish,
}: {
  onSend: (text: string) => void;
  running?: boolean;
  onInterrupt?: () => void;
  placeholder?: string;
  /** 发送快捷键的平台标签（`Ctrl+Enter` / `⌘Enter`），宿主从 status 里取。 */
  sendHint?: string;
  /** 已排队、还没发出去的消息条数。 */
  queueCount: number;
  onClearQueue: () => void;
  /**
   * 调 prompt-polish 改写草稿，返回改写后的文本。
   *
   * 形状是「拿草稿、还文本」而不是「父组件塞 value 下来」：草稿只活在
   * 本组件里（受控源在这里），让父组件经一道 props 往返只会多一个
   * 「两边各存一份、不知道谁最新」的坑。失败返回 `null`，本组件不动文本。
   */
  onPolish?: (draft: string) => Promise<string | null>;
}) {
  const [value, setValue] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** 润色前的原文。非空 = 显示「撤销润色」。一打字就作废：那是新的草稿了。 */
  const [polishBackup, setPolishBackup] = useState<string | null>(null);
  /**
   * 润色在跑。
   *
   * 刻意放在本组件而不是父组件：它是**输入区自己的**忙碌状态（按钮转圈 +
   * 防重复点），父组件不拿它做任何判断。2026-10-25 从 `CcGuiTab` 下沉到这里 ——
   * 多会话之后每条会话一个 pane，父组件为一份纯局部状态各存一个 `useState`
   * 只会把 pane 顶到体量门禁的天花板上。
   */
  const [polishing, setPolishing] = useState(false);
  /** 命令面板的高亮项。值一变就回 0（onChange 里做）。 */
  const [slashSel, setSlashSel] = useState(0);
  /** 用户按过 Esc：值不变就让面板一直关着，不然 Esc 毫无效果。 */
  const [slashDismissed, setSlashDismissed] = useState(false);
  /** 被闸门拦下的命令名。非空 = 显示提示；一打字就清。 */
  const [slashReject, setSlashReject] = useState<string | null>(null);
  /** 整个输入区（含面板）的定位锚点与「点外面关闭」的判定框。 */
  const boxRef = useRef<HTMLDivElement>(null);

  // 自动增高：内容变化时重算，上限 MAX_TEXTAREA_H。
  // 挂在 effect 里而不是 onChange 里：粘贴、程序回填（润色）也走同一条路。
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_H)}px`;
  }, [value]);

  // 命令面板：`/` 开头且没打空格时开着。Esc / 点外面关。
  const slashOpen = isSlashTyping(value) && !slashDismissed;
  const slashMatches = slashOpen ? filterSlash(value.slice(1)) : [];
  const slashActive = Math.min(slashSel, Math.max(0, slashMatches.length - 1));
  useEffect(() => {
    if (!slashOpen) return;
    const onDown = (e: PointerEvent) => {
      // 点在输入区里（含面板本身）不关：那是要继续打字。
      if (boxRef.current?.contains(e.target as Node)) return;
      setSlashDismissed(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSlashDismissed(true);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [slashOpen]);

  const send = () => {
    const text = value.trim();
    if (!text) return;
    // 闸门：白名单外的 slash 命令不发送。拦住时**不清空**输入——用户的字
    // 得留着改，只显示提示告诉他该去哪儿。
    const verdict = classifySlash(text);
    if (verdict.kind === "unknown") {
      setSlashReject(verdict.name);
      return;
    }
    onSend(text);
    setValue("");
    setSlashSel(0);
    setSlashReject(null);
    // 已发出的草稿不再可「撤销润色」：那会把旧稿填回空输入框，像是能撤回发送。
    setPolishBackup(null);
  };

  /** 把命令名填进输入框，尾部留一个空格给参数。不直接发：/model 要写参数。 */
  const insertSlash = (cmd: SlashCommand) => {
    setValue(`${cmd.name} `);
    setSlashSel(0);
  };

  /** 面板点选 / Enter。已经完整打出且不要参数的命令（/compact、/clear）
   *  直接发送——「打完回车就走」是最顺手的路径；其余落入输入框等补全。 */
  const pickSlash = (cmd: SlashCommand) => {
    if (value.trim() === cmd.name && !cmd.needsArg) {
      send();
      return;
    }
    insertSlash(cmd);
  };

  const polish = async () => {
    const draft = value.trim();
    if (!draft || !onPolish || polishing) return;
    setPolishing(true);
    try {
      const out = await onPolish(draft);
      // 只在真的拿到文本时动：失败时保持原样，用户那句草稿不能丢。
      if (out && out.trim()) {
        setPolishBackup(draft);
        setValue(out.trim());
      }
    } finally {
      // 失败 / 超时也要复位：卡在「润色中」的按钮再也点不动。
      setPolishing(false);
    }
  };

  return (
    <div ref={boxRef} className="relative shrink-0 px-3 pb-3 pt-1">
      <ComposerNotices queueCount={queueCount} onClearQueue={onClearQueue} slashReject={slashReject} />
      {/* data-cc-composer：玻璃下 composer 要压过 .ui-card 的 reading 档，改 floating
          （唯一「必须实心」的输入位）；classic 下不加任何样式。 */}
      <div
        data-cc-composer
        className="ui-card rounded-xl border border-border bg-card shadow-card transition-colors focus-within:border-primary/50"
      >
        <textarea
          ref={areaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSlashSel(0);
            setSlashDismissed(false);
            setSlashReject(null);
            // 一打字，润色备份就作废：那是新草稿，还原回去只会覆盖用户刚写的。
            if (polishBackup !== null) setPolishBackup(null);
          }}
          onPaste={(e) => {
            // 对话页走的是纯文本通道（协议不支持图片块）。终端页能粘贴截图，
            // 这里至少给一句去向说明，而不是毫无反应地丢掉。
            const hasImage = Array.from(e.clipboardData?.items ?? []).some((it) =>
              it.type.startsWith("image/"),
            );
            if (!hasImage) return;
            e.preventDefault();
            toast("对话页暂不支持粘贴图片：请到终端页粘贴（会自动上传并填入路径）", "info");
          }}
          onKeyDown={(e) => {
            // 🔴 IME 组合期间的键全部放行给输入法：此刻方向键在选候选词、Enter 在
            //    上屏。拦走任何一个，中文用户要么选不了词、要么半截拼音被当成
            //    命令补全 / 直接发送。
            if (isImeComposing(e.nativeEvent)) return;
            // 面板开着时方向键 / Enter / Tab 归它。Enter 在输入框里本是换行，
            // 但「正选着命令」的时刻用户要的是补全；换行还有 Shift+Enter
            // （浏览器原生行为，不用我们接）。
            if (slashOpen && slashMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashSel((v) => (v + 1) % slashMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashSel((v) => (v - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                insertSlash(slashMatches[slashActive]);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                pickSlash(slashMatches[slashActive]);
                return;
              }
            }
            // Windows 风格窗口：Ctrl+Enter 发送（不是 ⌘）。
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={placeholder ?? "给 CC 发消息…"}
          className="block max-h-[168px] w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 text-[13px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="text-[11px] text-muted-foreground">
            <span data-cc-inset className="rounded border border-border bg-muted/60 px-[3px] py-[1px] font-mono text-[11px]">
              {sendHint}
            </span>{" "}
            发送
          </span>
          {polishBackup !== null && (
            <button
              type="button"
              onClick={() => {
                setValue(polishBackup);
                setPolishBackup(null);
              }}
              className="text-[11px] text-muted-foreground underline decoration-dotted transition-colors hover:text-foreground"
            >
              撤销润色
            </button>
          )}
          {onPolish && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
              disabled={polishing || !value.trim()}
              onClick={() => void polish()}
              title="用提示词改写器把草稿改写成更清晰、可执行的指令（mods/prompt-polish）"
            >
              <Icon name={polishing ? "spinner" : "paintbrush"} size={12} />
              {polishing ? "润色中" : "润色"}
            </Button>
          )}
          {running && onInterrupt && (
            <Button variant="outline" size="sm" className="ml-auto h-7 px-3 text-[12px]" onClick={onInterrupt}>
              中断
            </Button>
          )}
          <Button
            size="sm"
            className={`${running && onInterrupt ? "" : "ml-auto"} h-7 px-3 text-[12px]`}
            disabled={!value.trim()}
            onClick={send}
          >
            {running ? "排队" : "发送"}
          </Button>
        </div>
      </div>
      {slashOpen && (
        <SlashPanel
          matches={slashMatches}
          active={slashActive}
          query={value.slice(1)}
          onPick={pickSlash}
        />
      )}
    </div>
  );
}

export const Composer = memo(ComposerImpl);
