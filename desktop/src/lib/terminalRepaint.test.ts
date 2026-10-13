import { describe, it, expect, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { forceRepaint } from "./terminalRepaint";

/** 记录 resize 调用序列的轻量 fake。 */
function fakeTerm(cols: number, rows: number) {
  const calls: Array<[number, number]> = [];
  const term = {
    cols,
    rows,
    resize: vi.fn((c: number, r: number) => {
      calls.push([c, r]);
    }),
  } as unknown as Terminal & { resize: ReturnType<typeof vi.fn> };
  return { term, calls };
}

describe("forceRepaint（一键强制重绘）", () => {
  it("resize cols-1 → cols 走一遍，行数不动", () => {
    const { term, calls } = fakeTerm(120, 30);
    forceRepaint(term);
    expect(calls).toEqual([
      [119, 30],
      [120, 30],
    ]);
  });
  it("term 为 null 安全跳过", () => {
    expect(() => forceRepaint(null)).not.toThrow();
  });
  it("cols<2 时跳过（减不出列）", () => {
    const { term, calls } = fakeTerm(1, 30);
    forceRepaint(term);
    expect(calls).toHaveLength(0);
  });
});
