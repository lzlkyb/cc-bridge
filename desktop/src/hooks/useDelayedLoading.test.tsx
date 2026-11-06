// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SKELETON_DELAY_MS, useDelayedLoading } from "./useDelayedLoading";

/* 延迟门的语义只有四条，但每条都会直接影响观感：
   ① 刚开始加载时不显示（否则等于没做延迟）；
   ② 超过阈值才显示；
   ③ 阈值内加载完，永远不显示（这是整套改动的目的：消灭「闪一下灰块」）；
   ④ 显示中数据到达，立即收起（不然内容都出来了骨架还挂着）。 */

let root: Root;
let host: HTMLDivElement;
let setLoading: (v: boolean) => void;

/** 探针把结果显示成 DOM 属性 —— 比收集渲染数组更直接，且能验证真实提交结果。 */
function Probe() {
  const [loading, set] = useState(true);
  setLoading = set;
  const show = useDelayedLoading(loading);
  return <div data-show={show ? "1" : "0"} />;
}

const shown = () => host.firstElementChild?.getAttribute("data-show") === "1";

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("刚开始加载时不显示骨架", () => {
  expect(shown()).toBe(false);
});

it("超过阈值后才显示", async () => {
  await act(async () => {
    vi.advanceTimersByTime(SKELETON_DELAY_MS + 20);
  });
  expect(shown()).toBe(true);
});

it("阈值内加载完则始终不显示", async () => {
  await act(async () => {
    vi.advanceTimersByTime(SKELETON_DELAY_MS - 40);
  });
  expect(shown()).toBe(false);
  await act(async () => {
    setLoading(false);
  });
  await act(async () => {
    vi.advanceTimersByTime(SKELETON_DELAY_MS * 2);
  });
  expect(shown()).toBe(false);
});

it("显示中数据到达会立即收起", async () => {
  await act(async () => {
    vi.advanceTimersByTime(SKELETON_DELAY_MS + 20);
  });
  expect(shown()).toBe(true);
  await act(async () => {
    setLoading(false);
  });
  expect(shown()).toBe(false);
});

it("loading 反复开关时计时从零重算，不继承上一轮", async () => {
  await act(async () => {
    vi.advanceTimersByTime(SKELETON_DELAY_MS - 50);
  });
  await act(async () => {
    setLoading(false);
  });
  await act(async () => {
    setLoading(true);
  });
  // 第二轮刚过 100ms，若还在用第一轮的起点就已经该显示了。
  await act(async () => {
    vi.advanceTimersByTime(SKELETON_DELAY_MS - 50);
  });
  expect(shown()).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(60);
  });
  expect(shown()).toBe(true);
});
