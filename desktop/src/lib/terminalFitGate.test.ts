import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { deferFitIfHeld, holdFit, isFitHeld, registerFitRunner, releaseFit } from "./terminalFitGate";

/** 闸只按 Terminal 实例做键，不碰它的任何字段；每个用例一个干净实例。 */
const mk = () => ({}) as Terminal;

describe("terminalFitGate — 手势期间挂起 fit", () => {
  it("未挂起时放行：热路径不记录任何状态", () => {
    expect(deferFitIfHeld(mk())).toBe(false);
  });

  it("挂起后拒绝本次 fit，并记成待补跑", () => {
    const term = mk();
    holdFit(term);
    expect(isFitHeld(term)).toBe(true);
    expect(deferFitIfHeld(term)).toBe(true);
  });

  it("🔴 手势结束补跑一次：期间来过几次请求都只跑一次（30 帧过渡不该补 30 次）", () => {
    const term = mk();
    const run = vi.fn();
    registerFitRunner(term, run);
    holdFit(term);
    for (let i = 0; i < 30; i++) deferFitIfHeld(term);
    releaseFit(term);
    expect(run).toHaveBeenCalledTimes(1);
    expect(isFitHeld(term)).toBe(false);
  });

  it("期间没有请求 ⇒ 不补跑（别凭空 resize：行数变了会清掉用户刚拖好的选区）", () => {
    const term = mk();
    const run = vi.fn();
    registerFitRunner(term, run);
    holdFit(term);
    releaseFit(term);
    expect(run).not.toHaveBeenCalled();
  });

  it("开闸后恢复正常放行", () => {
    const term = mk();
    holdFit(term);
    releaseFit(term);
    expect(deferFitIfHeld(term)).toBe(false);
  });

  it("重复释放是幂等的（多释放点共用一个入口）", () => {
    const term = mk();
    const run = vi.fn();
    registerFitRunner(term, run);
    holdFit(term);
    deferFitIfHeld(term);
    releaseFit(term);
    releaseFit(term);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("没登记 runner 时释放不抛（终端未挂载 / 已销毁）", () => {
    const term = mk();
    holdFit(term);
    deferFitIfHeld(term);
    expect(() => releaseFit(term)).not.toThrow();
  });
});
