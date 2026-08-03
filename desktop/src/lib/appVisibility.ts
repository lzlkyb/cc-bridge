import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * 全局窗口可见性 store。
 *
 * 两个消费方：
 * 1. CSS：在 `<html>` 上置 `data-app-hidden`，`index.css` 据此暂停全部动画/过渡；
 * 2. React：`useAppHidden()` 让组件拿到布尔值，给 `refetchInterval` / `setInterval` 断流。
 *
 * **为何用模块级 store 而不是 Context**：`App` 自身的 `useQuery` 也要读这个状态，
 * 而 Provider 只能包在 `App` 外层，会多一层组件且很容易忘。模块级 store +
 * `useSyncExternalStore` 让任何组件（包括 `App` 本身）直接读，且全局只订阅一次
 * Tauri 事件（而不是每个消费者各订一次）。
 *
 * 信号源两路取“或”：
 * 1. Rust 侧 `app:visibility` 事件（权威）—— 托盘左键 toggle / 托盘菜单“显示” /
 *    关窗收托盘 / OS 级最小化（Resized 边缘检测）四处都会发；
 * 2. `document.hidden` —— 兜底 WebView2 自己能感知的场景。
 *
 * 已知局限：若系统既不发 visibilitychange、又不走上面四个路径（罕见），则不会暂停。
 * 取舍：宁可漏暂停也不能误暂停——后者会让可见界面的动画冻住、轮询停死。
 */

let hidden = false;
let hiddenByHost = false;
const listeners = new Set<() => void>();

function recompute() {
  const next = hiddenByHost || document.hidden;
  // 去重：同值不通知，避免无谓重渲染（Resized 事件会密集到达）。
  if (next === hidden) return;
  hidden = next;
  const root = document.documentElement;
  if (hidden) root.setAttribute("data-app-hidden", "");
  else root.removeAttribute("data-app-hidden");
  listeners.forEach((l) => l());
}

/** 订阅可见性变化（非 React 消费者与单测用；React 里直接用 `useAppHidden()`）。 */
export function subscribeAppVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读当前值（store 的 getSnapshot）。 */
export function isAppHidden(): boolean {
  return hidden;
}

/** 窗口是否不可见。用法：`refetchInterval: useAppHidden() ? false : 5000` */
export function useAppHidden(): boolean {
  // 第三个参数（getServerSnapshot）固定返回 false：本应用无 SSR，但组件测试里可能没有
  // document，给个安全默认值避免报错。
  return useSyncExternalStore(subscribeAppVisibility, isAppHidden, () => false);
}

let initialized = false;
let disposeInner: (() => void) | undefined;

/**
 * 启动可见性监听（幂等，全局只需调一次，由 `useAppHiddenFlag()` 在 App 顶层调用）。
 * 返回 teardown；重复调用返回空函数。
 */
export function initAppVisibility(): () => void {
  if (initialized) return () => {};
  initialized = true;

  const onVisibilityChange = () => recompute();
  document.addEventListener("visibilitychange", onVisibilityChange);

  let unlisten: (() => void) | undefined;
  let disposed = false;
  // 非 Tauri 环境（如浏览器里跑 vite dev）listen 会失败，忽略即可，
  // 此时仅靠 visibilitychange 工作。
  listen<boolean>("app:visibility", (event) => {
    hiddenByHost = !event.payload;
    recompute();
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});

  recompute();

  disposeInner = () => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unlisten?.();
    // 清掉标记并复位，避免热更新后动画被永久冻住、轮询永久停死。
    hiddenByHost = false;
    hidden = false;
    document.documentElement.removeAttribute("data-app-hidden");
    listeners.forEach((l) => l());
    initialized = false;
    disposeInner = undefined;
  };
  return disposeInner;
}

/** 仅测试用：重置模块级状态，避免用例间污染。 */
export function __resetAppVisibilityForTest() {
  disposeInner?.();
  listeners.clear();
  hiddenByHost = false;
  hidden = false;
  initialized = false;
}
