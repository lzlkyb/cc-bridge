// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScrollFade } from "./useScrollFade";

let root: Root;
let host: HTMLDivElement;
let el: HTMLDivElement;
/** jsdom 不做布局：scrollWidth / clientWidth / scrollLeft 全是 0，必须自己接管。 */
let metrics = { scroll: 100, client: 100, left: 0 };

function Probe() {
  // ref 由 hook 自己持有；测试用 host.firstElementChild 拿元素，不去碰只读的 ref.current。
  return <div ref={useScrollFade<HTMLDivElement>()} />;
}

/** 改尺寸后派发 scroll：sync 只挂在 scroll / RO / MO 上，jsdom 不会自己触发。 */
async function apply(next: Partial<typeof metrics>) {
  metrics = { ...metrics, ...next };
  await act(async () => {
    el.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  metrics = { scroll: 100, client: 100, left: 0 };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
  el = host.firstElementChild as HTMLDivElement;
  Object.defineProperty(el, "scrollWidth", { get: () => metrics.scroll, configurable: true });
  Object.defineProperty(el, "clientWidth", { get: () => metrics.client, configurable: true });
  Object.defineProperty(el, "scrollLeft", { get: () => metrics.left, configurable: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const fade = () => ({
  left: el.hasAttribute("data-fade-left"),
  right: el.hasAttribute("data-fade-right"),
});

it("没有溢出时两侧都不渐隐（否则边缘标签会被无谓地淡掉）", async () => {
  await apply({ scroll: 100, client: 100 });
  expect(fade()).toEqual({ left: false, right: false });
});

it("溢出且停在最左：只有右侧渐隐", async () => {
  await apply({ scroll: 300, client: 100, left: 0 });
  expect(fade()).toEqual({ left: false, right: true });
});

it("滚到中间：两侧都渐隐", async () => {
  await apply({ scroll: 300, client: 100, left: 100 });
  expect(fade()).toEqual({ left: true, right: true });
});

it("滚到最右：只剩左侧渐隐（容差 1px，像素对齐差一点也要判成到底）", async () => {
  await apply({ scroll: 300, client: 100, left: 200 });
  expect(fade()).toEqual({ left: true, right: false });
  await apply({ left: 199 });
  expect(fade()).toEqual({ left: true, right: false });
});

it("🔴 标签增减不改变容器宽度：只有 MutationObserver 能发现溢出状态变了", async () => {
  await apply({ scroll: 100, client: 100 });
  expect(fade()).toEqual({ left: false, right: false });
  // 模拟「多开一个标签」：宽度只从 scrollWidth 反映，ResizeObserver 收不到通知。
  metrics.scroll = 260;
  await act(async () => {
    el.append(document.createElement("span"));
  });
  expect(fade()).toEqual({ left: false, right: true });
});
