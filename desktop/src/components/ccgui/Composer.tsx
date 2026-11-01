import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "../ui/toast";
import { classifySlash } from "../../lib/ccSlash";
import { isSendKey, useSendKey } from "../../lib/ccSendKey";
import type { CcImage } from "../../lib/ccImage";
import { useCcMention } from "../../hooks/useCcMention";
import { useCcDropImages } from "../../hooks/useCcDropImages";
import { useComposerDraft } from "../../hooks/useComposerDraft";
import { useComposerPolish } from "../../hooks/useComposerPolish";
import { useCcSlashInput } from "../../hooks/useCcSlashInput";
import { ComposerAttachments, type ComposerAttachHandle } from "./ComposerAttachments";
import { ComposerDraft } from "./ComposerDraft";
import { ComposerNotices } from "./ComposerNotices";
import { ComposerFooter, ComposerTools } from "./ComposerTools";
import type { QueuedMessage } from "../../hooks/useCcSendQueue";
import { ComposerPolishPreview } from "./ComposerPolishPreview";
import "./composer.css";
import { useCcDraftInsert } from "../../hooks/useCcDraftInsert"; import { DraftContextList } from "./DraftContextList"; import { MentionPanel } from "./MentionPanel";
import { SlashPanel } from "./SlashPanel";
import { InputReceipts } from "./InputReceipts";
import type { CcInputMode, CcInputs } from "../../lib/ccInput";

/**
 * 输入区（接管 composer 位置，不弹模态）。
 * 运行中默认补充当前任务；立即调整走软中断，下一轮发送保留独立队列。
 *
 * ## slash 命令（白名单闸门）
 *
 * 值以 `/` 开头时浮出命令面板；发送前 `classifySlash` 判定：白名单内的
 * （/compact /clear /model）原样转发给 CLI 执行，其余一律拦住并提示去向 ——
 * 未知命令当提示词发给模型只会浪费一轮。判定与白名单在 `lib/ccSlash.ts`。
 */
function ComposerImpl({
  onSend,
  running, stopping,
  onInterrupt, onStopAndSend,
  onSteer, onSendNow, inputs,
  placeholder,
  sendHint = "Ctrl+Enter",
  queueCount,
  queuePaused,
  onClearQueue,
  onResumeQueue,
  onPolish,
  mentionSource,
  prefill,
  draftKey,
  controls,
  footer,
  queueItems,
  onEditQueue,
  onRemoveQueue, onMoveQueue, pendingCount,
  onShowPending,
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
  stopping?: boolean;
  onInterrupt?: () => void; onStopAndSend?: (text: string, images: CcImage[]) => Promise<boolean>;
  onSteer?: (text: string, images: CcImage[]) => Promise<boolean>;
  onSendNow?: (text: string, images: CcImage[]) => Promise<boolean>;
  inputs?: CcInputs;
  placeholder?: string;
  /** 发送快捷键的平台标签（`Ctrl+Enter` / `⌘Enter`），宿主从 status 里取。 */
  sendHint?: string;
  /** 已排队、还没发出去的消息条数。 */
  queueCount: number;
  /** 队首发送失败、自动发送已暂停（见 `useCcSession`）。 */
  queuePaused?: boolean;
  onClearQueue: () => void;
  /** 解除暂停、继续发（暂停时提示条上的「继续」）。 */
  onResumeQueue?: () => void;
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
  /** 草稿落盘的键（`CcPane` 传 `paneKey`）：关窗口 / 重启后回来，字还在。不负责
   *  切 app 标签（`CcGuiTab` 是 `keepMounted`）；取舍见 `lib/ccDraft.ts`。 */
  draftKey: string;
  controls?: ReactNode;
  footer?: ReactNode;
  queueItems?: QueuedMessage[];
  onEditQueue?: (id: string, text: string) => boolean;
  onRemoveQueue?: (id: string) => void;
  onMoveQueue?: (id: string, direction: -1 | 1) => void;
  pendingCount?: number;
  onShowPending?: () => void;
}) {
  const [value, setValue] = useComposerDraft(draftKey);
  /** 发送键偏好（Enter / Ctrl+Enter），全局记忆。 */
  const sendKey = useSendKey();
  const command = /^[!/]/.test(value.trimStart());
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** 待发图片区的把手（用 ref 而不是把附件状态提到这里，理由见 ComposerAttachments）。 */
  const attachRef = useRef<ComposerAttachHandle>(null);
  /** 有图时发送按钮要能点亮 —— 这是唯一需要订阅的附件状态。 */
  const [hasImages, setHasImages] = useState(false);
  const [imagesBusy, setImagesBusy] = useState(false);
  const [sending, setSending] = useState(false), [delivery, setDelivery] = useState<CcInputMode>(onSteer ? "steer" : "queue");
  const fileRef = useRef<HTMLInputElement>(null);
  // 润色草稿的备份与忙碌态（2026-10-26 外移到 hooks/useComposerPolish.ts）。
  const polish = useComposerPolish(onPolish);
  /** 整个输入区（含面板）的定位锚点与「点外面关闭」的判定框。 */
  const boxRef = useRef<HTMLDivElement>(null); useCcDraftInsert(boxRef, areaRef, setValue);
  // @引用补全（设计稿《对话页-@引用与排版偏好》）：状态与取数全在 hook 里，
  // 这里只接线 —— Composer 本体已贴体量门限，不能再长。
  const mention = useCcMention({
    value,
    setValue,
    connectionId: mentionSource.connectionId,
    cwd: mentionSource.cwd,
  });

  /** 拖图进输入区（与粘贴同一条通道，见 `useCcDropImages`）。 */
  const drop = useCcDropImages((files) => attachRef.current?.add(files));

  // 外部预填（空状态示例 prompt）：填进草稿并聚焦，光标落到末尾，用户可改后再发。
  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    // 值更新后再放光标：同步设会落在旧值的位置。
    requestAnimationFrame(() => el.setSelectionRange(prefill.text.length, prefill.text.length));
    // `setValue` 是 `useState` 的 setter（引用恒定），列出只为让 exhaustive-deps 看得见。
  }, [prefill, setValue]);

  // slash 命令交互（面板开合 / 补全 / 键位）见 `useCcSlashInput`。
  const slash = useCcSlashInput(value, setValue, boxRef);

  // 发送 IPC 在途的同步锁：`onSend` 要等后端起进程（远端 SSH 可能数秒），输入框在它返回后才清空。
  // 没有这把锁时按住 Ctrl+Enter / 连点发送，第二次会把同一条文本再排进队列。
  // 用 ref 而不是 state：state 要等下一次渲染才生效，挡不住同一帧内的连发。
  const sendingRef = useRef(false);

  const send = async (forcedMode?: CcInputMode) => {
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
    setSending(true);
    try {
      const mode = text.startsWith("/") || text.startsWith("!") ? "queue" : forcedMode ?? delivery;
      const submit = !running || mode === "queue" ? onSend : mode === "steer" ? onSteer ?? onSend : onSendNow ?? onStopAndSend ?? onSend;
      const accepted = await submit(text, images);
      if (accepted === false) return;
      // 发送在途时用户若又改了输入框，那是新草稿，不能跟着已发出的那句一起清掉。
      setValue((cur) => (cur.trim() === text ? "" : cur));
      setDelivery(onSteer ? "steer" : "queue"); slash.onSent();
      // 已发出的草稿不再可「撤销润色」：那会把旧稿填回空输入框，像是能撤回发送。
      polish.reset();
      attachRef.current?.clear(images);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /** 润色当前草稿。失败时文本一个字都不动（用户那句草稿不能丢）。 */
  const runPolish = async () => {
    try { await polish.run(value); }
    catch { toast("润色未完成，原稿已保留", "info"); }
  };

  const insertMention = () => {
    const el = areaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const prefix = value.slice(0, caret);
    const token = prefix && !/\s$/.test(prefix) ? " @" : "@";
    const next = prefix + token + value.slice(el?.selectionEnd ?? caret);
    setValue(next);
    polish.reset();
    mention.syncCaret(caret + token.length);
    el?.focus();
    requestAnimationFrame(() => el?.setSelectionRange(caret + token.length, caret + token.length));
  };

  return (
    <div ref={boxRef} className="cc-composer-dock">
      <InputReceipts inputs={inputs} onRecover={text => { setValue(cur => cur.trim() ? `${cur}\n${text}` : text); areaRef.current?.focus(); }} />
      <ComposerNotices
        queueCount={queueCount}
        queuePaused={queuePaused}
        onClearQueue={onClearQueue}
        onResumeQueue={onResumeQueue}
        slashReject={slash.reject}
        queueItems={queueItems}
        onEditQueue={onEditQueue}
        onRemoveQueue={onRemoveQueue} onMoveQueue={onMoveQueue}
        pendingCount={pendingCount}
        onShowPending={onShowPending}
      />
      {/* 复合输入面独立承载材质，避免通用卡片给 textarea 再铺一层背景。 */}
      <div
        data-cc-composer
        {...drop.handlers}
        className={`cc-composer-surface relative rounded-xl border bg-card transition-colors ${
          // 拖拽中把整块描成虚线主色：不提示的话用户不知道「这里能放」，
          // 而拖到别处会被浏览器当成「用这个文件打开新页面」。
          drop.over ? "border-dashed border-primary/60 ring-2 ring-primary/15" : "border-border"
        }`}
      >
        {drop.over && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/85 text-[12px] font-medium text-primary">
            松手添加图片
          </div>
        )}
        <ComposerAttachments ref={attachRef} onHasImages={setHasImages} onBusy={setImagesBusy} />
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={event => { attachRef.current?.add(Array.from(event.target.files ?? [])); event.target.value = ""; areaRef.current?.focus(); }} />
        <ComposerDraft areaRef={areaRef} value={value} placeholder={placeholder}
          onChange={(text, caret) => { setValue(text); mention.syncCaret(caret); slash.onTyped(); polish.reset(); }}
          onCaret={mention.syncCaret}
          onImages={files => attachRef.current?.add(files)}
          onKeyDown={event => {
            if (mention.open && mention.handleKey(event)) return;
            if (slash.handleKey(event, () => void send())) return;
            if (running && onSendNow && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) { event.preventDefault(); void send("now"); return; }
            if (isSendKey(sendKey, event)) { event.preventDefault(); void send(); }
          }}
        />
        <ComposerTools
          controls={controls} delivery={command ? "queue" : delivery} onDeliveryChange={onSteer || onSendNow || onStopAndSend ? setDelivery : undefined} steeringEnabled={!!onSteer}
          sending={sending}
          imagesBusy={imagesBusy}
          queuePaused={queuePaused}
          queueCount={queueCount}
          polishing={polish.polishing}
          onPolish={polish.enabled ? () => void runPolish() : undefined}
          running={running}
          stopping={stopping}
          onInterrupt={onInterrupt}
          canSend={!!value.trim() || hasImages}
          onSend={() => { void send(); areaRef.current?.focus(); }}
          onAttach={() => fileRef.current?.click()}
          onMention={insertMention}
          onCommand={() => { if (value.trim() && !value.startsWith("/")) { toast("先发送或保留当前草稿，再输入 / 查看命令", "info"); areaRef.current?.focus(); return; } setValue("/"); slash.onTyped(); areaRef.current?.focus(); }}
        />
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
      <ComposerFooter sendHint={sendHint} steering={running && !!onSendNow && !command}><DraftContextList value={value} onChange={setValue} hasImages={hasImages}/>{footer}</ComposerFooter>
      {polish.preview?.source === value && <ComposerPolishPreview anchorRef={areaRef} text={polish.preview.text} onCancel={polish.reset} onApply={() => { setValue(polish.preview!.text); polish.reset(); areaRef.current?.focus(); }} />}
    </div>
  );
}

export const Composer = memo(ComposerImpl);
