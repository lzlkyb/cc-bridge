import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { readDraft, writeDraft } from "../lib/ccDraft";

/**
 * 打字停下多久后落盘。
 *
 * 不能每次按键都写：`localStorage.setItem` 是**同步**的，一段 20k 字符的草稿
 * 每敲一个字写一遍会把输入卡出节奏感（而且它跑在主线程上）。400ms 够短 ——
 * 用户停下来想事情的间隙就写完了，而崩溃时最多丢这 400ms 里敲的几个字。
 */
const WRITE_DELAY = 400;

/**
 * 输入框草稿：受控值 + 落盘。
 *
 * 读是同步的，放在 `useState` 的惰性初值里 —— 否则会先渲染一个空输入框、
 * 下一帧才补上内容，那一下闪烁足够让人以为「字没了」。
 *
 * `pane` 在组件生命周期内是常量（React key 就是它，pane 之间不会复用实例），
 * 所以不做「换 key 时重读」那套。
 *
 * ## 两条写入路径
 *
 * 1. **防抖写**：值变了等 400ms 再写。覆盖「一直打字」这条主路径。
 * 2. **卸载 / pagehide 时补写一次**：防抖窗口里被关掉时兜一下。
 *
 * ⚠️ 第 2 条是**尽力而为，不是保证**，别把它当契约：`release_webview_on_close`
 * 默认为 true（省内存模式），关窗口时 Rust 侧**不** `prevent_close`，窗口连同
 * webview 一起销毁 —— 那种销毁不是「页面卸载」，`pagehide` 与 React 卸载通道
 * 都可能不来。所以**最后约 400ms 里敲的字仍可能丢**。
 *
 * 要彻底堵住只有一条路：JS 侧 `onCloseRequested` 里先 `preventDefault()`、刷完
 * 再自己 `destroy()`。代价是 webview 一旦卡住窗口就关不掉 —— 比丢几个字严重
 * 得多，所以刻意不做。
 *
 * 没有在 `beforeunload` 上做：那里做同步 I/O 会拖慢关闭，而且同样受上面那条限制。
 */
export function useComposerDraft(pane: string): [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState(() => readDraft(pane));

  /**
   * 最新值的镜像。
   *
   * 🔴 卸载时的 cleanup 闭包捕获的是**那一次渲染**的 `value`，而 cleanup 真正
   *    跑的时候往往已经晚了一两次渲染 —— 拿捕获值就会把倒数第二个字写进去，
   *    表现为「回去重开，最后几个字没了」。ref 才是「此刻的最新」。
   */
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    const t = window.setTimeout(() => writeDraft(pane, value), WRITE_DELAY);
    return () => window.clearTimeout(t);
  }, [pane, value]);

  useEffect(() => {
    const flush = () => writeDraft(pane, latest.current);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [pane]);

  return [value, setValue];
}
