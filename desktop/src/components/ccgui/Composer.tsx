import { memo, useEffect, useRef, useState } from "react";
import { toast } from "../ui/toast";
import { classifySlash } from "../../lib/ccSlash";
import { isImeComposing } from "../../lib/utils";
import type { CcImage } from "../../lib/ccImage";
import { useCcMention } from "../../hooks/useCcMention";
import { useComposerPolish } from "../../hooks/useComposerPolish";
import { useCcSlashInput } from "../../hooks/useCcSlashInput";
import {
  ComposerAttachments,
  collectPastedImages,
  type ComposerAttachHandle,
} from "./ComposerAttachments";
import { ComposerNotices } from "./ComposerNotices";
import { ComposerTools } from "./ComposerTools";
import { MentionPanel } from "./MentionPanel";
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
  queuePaused,
  onClearQueue,
  onPolish,
  mentionSource,
  prefill,
}: {
  /**
   * 发一条消息。`images` 是这条消息附的图（可能为空数组）。
   *
   * 返回 `false` 表示**没送出去**（后端拒了 / 会话还没就绪）：调用方据此
   * 保留草稿与附件。返回 `true`（或 undefined，兼容旧调用方）视为已受理 ——
   * 排队也算受理，那条消息迟早会发出去。
   */
  onSend: (
    text: string,
    images: CcImage[],
  ) => Promise<boolean> | boolean | void;
  running?: boolean;
  onInterrupt?: () => void;
  placeholder?: string;
  /** 发送快捷键的平台标签（`Ctrl+Enter` / `⌘Enter`），宿主从 status 里取。 */
  sendHint?: string;
  /** 已排队、还没发出去的消息条数。 */
  queueCount: number;
  /** 队首发送失败、自动发送已暂停（见 `useCcSession`）。 */
  queuePaused?: boolean;
  onClearQueue: () => void;
  /** @引用补全的目标与本会话目录（远端目标列远端目录，见 useCcMention）。 */
  mentionSource: { connectionId: string; cwd: string };
  /**
   * 调 prompt-polish 改写草稿，返回改写后的文本。
   *
   * 形状是「拿草稿、还文本」而不是「父组件塞 value 下来」：草稿只活在
   * 本组件里（受控源在这里），让父组件经一道 props 往返只会多一个
   * 「两边各存一份、不知道谁最新」的坑。失败返回 `null`，本组件不动文本。
   */
  onPolish?: (draft: string) => Promise<string | null>;
  /** 外部往输入框填一段草稿（空状态的示例 prompt）。`nonce` 变就重填，同一句连点两次也生效。 */
  prefill?: { text: string; nonce: number } | null;
}) {
  const [value, setValue] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** 待发图片区的把手（用 ref 而不是把附件状态提到这里，理由见 ComposerAttachments）。 */
  const attachRef = useRef<ComposerAttachHandle>(null);
  /** 有图时发送按钮要能点亮 —— 这是唯一需要订阅的附件状态。 */
  const [hasImages, setHasImages] = useState(false);
  // 润色草稿的备份与忙碌态（2026-10-26 外移到 hooks/useComposerPolish.ts）。
  const polish = useComposerPolish(onPolish);
  /** 整个输入区（含面板）的定位锚点与「点外面关闭」的判定框。 */
  const boxRef = useRef<HTMLDivElement>(null);
  // @引用补全（设计稿《对话页-@引用与排版偏好》）：状态与取数全在 hook 里，
  // 这里只接线 —— Composer 本体已贴体量门限，不能再长。
  const mention = useCcMention({
    value,
    setValue,
    connectionId: mentionSource.connectionId,
    cwd: mentionSource.cwd,
  });

  // 自动增高：内容变化时重算，上限 MAX_TEXTAREA_H。
  // 挂在 effect 里而不是 onChange 里：粘贴、程序回填（润色）也走同一条路。
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_H)}px`;
  }, [value]);

  // 外部预填（空状态示例 prompt）：填进草稿并聚焦，光标落到末尾，用户可改后再发。
  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    // 值更新后再放光标：同步设会落在旧值的位置。
    requestAnimationFrame(() => el.setSelectionRange(prefill.text.length, prefill.text.length));
  }, [prefill]);

  // slash 命令交互（面板开合 / 补全 / 键位）见 `useCcSlashInput`。
  const slash = useCcSlashInput(value, setValue, boxRef);

  // 发送 IPC 在途的同步锁：`onSend` 要等后端起进程（远端 SSH 可能数秒），输入框在它返回后才清空。
  // 没有这把锁时按住 Ctrl+Enter / 连点发送，第二次会把同一条文本再排进队列。
  // 用 ref 而不是 state：state 要等下一次渲染才生效，挡不住同一帧内的连发。
  const sendingRef = useRef(false);

  const send = async () => {
    if (sendingRef.current) return;
    const text = value.trim();
    const images = attachRef.current?.ready() ?? [];
    // 图还在编码：此刻发出去只有文字到达，用户却以为图也跟着走了。
    // 拦在这里比发出去再补一句「图没发成功」便宜得多。
    if (attachRef.current?.busy()) {
      toast("图片还在处理，稍等一下再发", "info");
      return;
    }
    // 纯图片消息合法：没有文字但有图就照发。
    if (!text && images.length === 0) return;
    // 闸门：白名单外的 slash 命令不发送。拦住时**不清空**输入——用户的字
    // 得留着改，只显示提示告诉他该去哪儿。
    const verdict = classifySlash(text);
    if (verdict.kind === "unknown") {
      slash.setReject(verdict.name);
      return;
    }
    // 发送失败 ⇒ 草稿与附件都留着。那是用户刚拼好的东西，
    // 一次后端抖动就清掉会让人重贴一遍图。
    sendingRef.current = true;
    try {
      const accepted = await onSend(text, images);
      if (accepted === false) return;
      // 发送在途时用户若又改了输入框，那是新草稿，不能跟着已发出的那句一起清掉。
      setValue((cur) => (cur.trim() === text ? "" : cur));
      slash.onSent();
      // 已发出的草稿不再可「撤销润色」：那会把旧稿填回空输入框，像是能撤回发送。
      polish.reset();
      attachRef.current?.clear(images);
    } finally {
      sendingRef.current = false;
    }
  };

  /** 润色当前草稿。失败时文本一个字都不动（用户那句草稿不能丢）。 */
  const runPolish = async () => {
    const out = await polish.run(value.trim());
    if (out !== null) setValue(out);
  };

  return (
    <div ref={boxRef} className="relative shrink-0 px-3 pb-3 pt-1">
      <ComposerNotices
        queueCount={queueCount}
        queuePaused={queuePaused}
        onClearQueue={onClearQueue}
        slashReject={slash.reject}
      />
      {/* data-cc-composer：玻璃下 composer 要压过 .ui-card 的 reading 档，改 floating
          （唯一「必须实心」的输入位）；classic 下不加任何样式。 */}
      <div
        data-cc-composer
        className="ui-card rounded-xl border border-border bg-card shadow-card transition-colors focus-within:border-primary/50"
      >
        <ComposerAttachments ref={attachRef} onHasImages={setHasImages} />
        <textarea
          ref={areaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            mention.syncCaret(e.target.selectionStart);
            slash.onTyped();
            // 一打字，润色备份就作废：那是新草稿，还原回去只会覆盖用户刚写的。
            polish.reset();
          }}
          onSelect={(e) => mention.syncCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            // 图片走附件通道（协议已通，见 docs/图片输入协议探针-2026-10-26.md）。
            // 没有图片时一律放行，粘贴文本/富文本的行为一个字都不改。
            const files = collectPastedImages(e.clipboardData);
            if (files.length === 0) return;
            e.preventDefault();
            attachRef.current?.add(files);
          }}
          onKeyDown={(e) => {
            // 🔴 IME 组合期间的键全部放行给输入法：此刻方向键在选候选词、Enter 在
            //    上屏。拦走任何一个，中文用户要么选不了词、要么半截拼音被当成
            //    命令补全 / 直接发送。
            if (isImeComposing(e.nativeEvent)) return;
            // @引用面板开着时方向键 / Enter / Tab / Esc 归它（焦点在 textarea，见 MentionPanel）。
            if (mention.open && mention.handleKey(e)) return;
            if (slash.handleKey(e, () => void send())) return;
            // Windows 风格窗口：Ctrl+Enter 发送（不是 ⌘）。
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={placeholder ?? "给 CC 发消息…"}
          className="block max-h-[168px] w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 text-[13px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <ComposerTools
          sendHint={sendHint}
          polishBackup={polish.backup}
          onUndoPolish={() => {
            const prev = polish.undo();
            if (prev !== null) setValue(prev);
          }}
          polishing={polish.polishing}
          onPolish={polish.enabled ? () => void runPolish() : undefined}
          running={running}
          onInterrupt={onInterrupt}
          canSend={!!value.trim() || hasImages}
          onSend={send}
        />
      </div>
      {slash.open && (
        <SlashPanel
          matches={slash.matches}
          active={slash.active}
          query={value.slice(1)}
          onPick={(c) => slash.pick(c, () => void send())}
        />
      )}
      {mention.open && (
        <MentionPanel
          items={mention.items}
          active={mention.active}
          filter={mention.filter}
          crumb={mention.crumb}
          loading={mention.loading}
          error={mention.error}
          onPick={mention.pick}
          onHover={mention.hover}
        />
      )}
    </div>
  );
}

export const Composer = memo(ComposerImpl);
