import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_MIN_INTERVAL_MS,
  createMotionThrottle,
  isMotionReport,
  parseMouseReport,
} from "./terminalMouseMotion";

const sgr = (b: number, x: number, y: number, final: "M" | "m" = "M") => `\x1b[<${b};${x};${y}${final}`;

describe("鼠标报告解析", () => {
  it("SGR 移动（无按键 35）被识别为移动", () => {
    const r = parseMouseReport(sgr(35, 12, 7));
    expect(r).toEqual({ button: 35, x: 12, y: 7, final: "M" });
    expect(isMotionReport(r!)).toBe(true);
  });

  it("按住左键拖动（32）也是移动，滚轮（64/65）不是", () => {
    expect(isMotionReport(parseMouseReport(sgr(32, 1, 1))!)).toBe(true);
    expect(isMotionReport(parseMouseReport(sgr(64, 1, 1))!)).toBe(false);
    expect(isMotionReport(parseMouseReport(sgr(65, 1, 1))!)).toBe(false);
  });

  it("按下 / 抬起不是移动", () => {
    expect(isMotionReport(parseMouseReport(sgr(0, 1, 1))!)).toBe(false);
    expect(isMotionReport(parseMouseReport(sgr(0, 1, 1, "m"))!)).toBe(false);
    expect(isMotionReport(parseMouseReport(sgr(32, 1, 1, "m"))!)).toBe(false);
    expect(parseMouseReport(sgr(0, 1, 1, "m"))!.final).toBe("m");
  });

  it("不是「恰好一条报告」就返回 null —— 键盘字符 / 粘贴 / 多条报告一律不接管", () => {
    expect(parseMouseReport("a")).toBeNull();
    expect(parseMouseReport(sgr(35, 1, 1) + sgr(35, 2, 2))).toBeNull();
    expect(parseMouseReport(sgr(35, 1, 1) + "x")).toBeNull();
    expect(parseMouseReport("\x1b[200~hello\x1b[201~")).toBeNull();
    expect(parseMouseReport("")).toBeNull();
  });
});

describe("移动报告削峰", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("洪峰里只发「立刻一条 + 窗口结束后最后一条」，中间位置被替换而不是丢光", () => {
    const sent: string[] = [];
    const t = createMotionThrottle((d) => sent.push(d));

    t.push(sgr(35, 1, 1)); // 距上次已超过窗口 ⇒ 立刻发
    t.push(sgr(35, 2, 1));
    t.push(sgr(35, 3, 1));
    t.push(sgr(35, 4, 1));
    expect(sent).toEqual([sgr(35, 1, 1)]);

    vi.advanceTimersByTime(MOTION_MIN_INTERVAL_MS);
    // 中间三条被合并成最后一条：最终位置一定送达（悬停高亮不会卡在旧格）
    expect(sent).toEqual([sgr(35, 1, 1), sgr(35, 4, 1)]);
  });

  it("同一格反复移动只发一条（TUI 每帧都会重发同样的坐标）", () => {
    const sent: string[] = [];
    const t = createMotionThrottle((d) => sent.push(d));
    for (let i = 0; i < 20; i++) t.push(sgr(35, 9, 9));
    vi.advanceTimersByTime(MOTION_MIN_INTERVAL_MS * 5);
    expect(sent).toEqual([sgr(35, 9, 9)]);
  });

  it("非移动事件到达前先把待发的移动落地——「移到这里再点」的顺序不能反", () => {
    const sent: string[] = [];
    const t = createMotionThrottle((d) => sent.push(d));
    t.push(sgr(35, 1, 1)); // 立刻发
    expect(t.push(sgr(35, 5, 5))).toBeNull(); // 进窗口，待发
    // 左键按下：不接管，返回「待发移动 + 点击」合并成的一条，顺序由字节流保证
    // （拆成两次 invoke 不可靠：后端 writer 是非公平 std Mutex，落盘顺序不保证）。
    expect(t.push(sgr(0, 5, 5))).toBe(sgr(35, 5, 5) + sgr(0, 5, 5));
    expect(sent).toEqual([sgr(35, 1, 1)]);
  });

  it("点击后的同格移动属于下一次交互，仍会发送", () => {
    const sent: string[] = [];
    const t = createMotionThrottle((d) => sent.push(d));
    const movement = sgr(35, 9, 9);
    t.push(movement);
    expect(t.push(sgr(0, 9, 9))).toBe(sgr(0, 9, 9));
    t.push(movement);
    vi.advanceTimersByTime(MOTION_MIN_INTERVAL_MS + 1);
    expect(sent).toEqual([movement, movement]);
  });

  it("没有待发移动时，非移动事件原样返回、字节一个不差", () => {
    const t = createMotionThrottle(() => undefined);
    expect(t.push("ls\r")).toBe("ls\r");
    expect(t.push("\x1b[200~粘贴\x1b[201~")).toBe("\x1b[200~粘贴\x1b[201~");
    // 多条报告拼在一起的输入不接管（parse 返回 null），必须原样交给调用方。
    const two = sgr(35, 1, 1) + sgr(35, 2, 2);
    expect(t.push(two)).toBe(two);
  });

  it("滚轮不接管、不合并：步数必须一条不少", () => {
    const sent: string[] = [];
    const t = createMotionThrottle((d) => sent.push(d));
    for (let i = 0; i < 5; i++) expect(t.push(sgr(65, 3, 3))).toBe(sgr(65, 3, 3));
    expect(sent).toEqual([]);
  });

  it("dispose 后不再发任何东西（会话已关）", () => {
    const sent: string[] = [];
    const t = createMotionThrottle((d) => sent.push(d));
    t.push(sgr(35, 1, 1));
    t.push(sgr(35, 2, 2));
    t.dispose();
    vi.advanceTimersByTime(MOTION_MIN_INTERVAL_MS * 10);
    expect(sent).toEqual([sgr(35, 1, 1)]);
  });
});
