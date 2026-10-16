import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  cancelPendingRelease,
  isSelectHold,
  releaseSelectHoldNow,
  releaseSelectHoldSoon,
  setInputHoldBase,
  setSelectHold,
} from "./terminalInputHold";

function fakeTerm(): { term: Terminal; opts: { disableStdin: boolean } } {
  const opts = { disableStdin: false };
  return { term: { options: opts } as unknown as Terminal, opts };
}

describe("terminalInputHold —— 两路来源求或", () => {
  it("两路都关 → 输入闸开（键盘鼠标正常）", () => {
    const { term, opts } = fakeTerm();
    setInputHoldBase(term, false);
    setSelectHold(term, false);
    expect(opts.disableStdin).toBe(false);
  });

  it("只闭选择闸 → 输入被拦（这是选择手势的全部作用）", () => {
    const { term, opts } = fakeTerm();
    setSelectHold(term, true);
    expect(opts.disableStdin).toBe(true);
    expect(isSelectHold(term)).toBe(true);
  });

  it("🔴 松开选择闸后基础闸仍生效（会话已断开不许把输入放开）", () => {
    const { term, opts } = fakeTerm();
    setInputHoldBase(term, true); // 会话断开
    setSelectHold(term, true);
    expect(opts.disableStdin).toBe(true);
    setSelectHold(term, false);
    expect(opts.disableStdin).toBe(true); // 仍被基础闸拦着
    expect(isSelectHold(term)).toBe(false);
  });

  it("🔴 基础闸解除时选择闸仍闭着 → 依旧是拦（两路互不覆盖）", () => {
    const { term, opts } = fakeTerm();
    setInputHoldBase(term, true);
    setSelectHold(term, true);
    setInputHoldBase(term, false);
    expect(opts.disableStdin).toBe(true);
  });

  it("按终端实例隔离：A 的闸不影响 B", () => {
    const a = fakeTerm();
    const b = fakeTerm();
    setSelectHold(a.term, true);
    expect(a.opts.disableStdin).toBe(true);
    expect(b.opts.disableStdin).toBe(false);
    expect(isSelectHold(b.term)).toBe(false);
  });
});

describe("延后一拍开闸（第六轮：松手不再当场清掉选区）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("🔴 调用后本拍内仍是闭闸——紧随 pointerup 的 mouseup 报告被拦，选区不会被清", () => {
    const { term, opts } = fakeTerm();
    setSelectHold(term, true);
    releaseSelectHoldSoon(term);
    expect(opts.disableStdin).toBe(true);
    expect(isSelectHold(term)).toBe(true);
    vi.runAllTimers();
    expect(opts.disableStdin).toBe(false);
    expect(isSelectHold(term)).toBe(false);
  });

  it("撤销：新一次按下先撤掉未决开闸（否则旧定时器会把新闸误开）", () => {
    const { term, opts } = fakeTerm();
    releaseSelectHoldSoon(term);
    cancelPendingRelease(term);
    setSelectHold(term, true);
    vi.runAllTimers();
    expect(opts.disableStdin).toBe(true);
  });

  it("重复调用只保留最后一次，不叠定时器", () => {
    const { term, opts } = fakeTerm();
    setSelectHold(term, true);
    releaseSelectHoldSoon(term);
    releaseSelectHoldSoon(term);
    vi.runAllTimers();
    expect(opts.disableStdin).toBe(false);
  });

  it("releaseSelectHoldNow 立即开闸，并撤掉未决定时器（异常出口用）", () => {
    const { term, opts } = fakeTerm();
    setSelectHold(term, true);
    releaseSelectHoldSoon(term);
    releaseSelectHoldNow(term);
    expect(opts.disableStdin).toBe(false);
    vi.runAllTimers();
    expect(opts.disableStdin).toBe(false);
  });
});
