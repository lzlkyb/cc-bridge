/**
 * 合并 xterm 文本输入通道上的高频 SGR 鼠标移动报告，减少送给远端 TUI 的写入。
 * 点击、抬起和滚轮都有独立操作语义，按原顺序发送。
 */
/** 归一化后的鼠标报告。`final === "m"` 是 SGR 的抬起。 */
export interface MouseReport {
  /** SGR button/motion 位：0 左/1 中/2 右/3 抬起，+32 移动，+64 滚轮，+4/+8/+16 修饰键。 */
  button: number;
  x: number;
  y: number;
  final: "M" | "m";
}

/** `\x1b[<b;x;yM` / `\x1b[<b;x;ym` */
// eslint-disable-next-line no-control-regex -- 要匹配的就是 ESC(0x1b) 控制字符
const SGR_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
/**
 * 解析**单条**鼠标报告。不是「恰好一条报告」就返回 null——
 * 携带键盘字符、粘贴内容或一次多条的 data 一律不接管（宁可多发，不可错合并）。
 */
export function parseMouseReport(data: string): MouseReport | null {
  const sgr = SGR_RE.exec(data);
  if (sgr) {
    return {
      button: Number(sgr[1]),
      x: Number(sgr[2]),
      y: Number(sgr[3]),
      final: sgr[4] as "M" | "m",
    };
  }
  return null;
}

/**
 * 是否「移动」类：bit 5（32）= 有移动，bit 6（64）= 滚轮。
 * 滚轮也带 32？不——xterm / xterm.js 的滚轮用 64/65，不走移动位。
 */
export function isMotionReport(r: MouseReport): boolean {
  return r.final === "M" && (r.button & 32) !== 0 && (r.button & 64) === 0;
}

/** 节流窗口：40ms ≈ 25Hz。人眼对悬停高亮的跟随在这个频率上已无感。 */
export const MOTION_MIN_INTERVAL_MS = 40;

export interface MotionThrottle {
  /**
   * 喂一条输入数据。
   *
   * - 返回 `null`：已接管（排队或丢弃），调用方**不要**再发这条；
   * - 返回字符串：调用方应发送的内容。非移动事件到来时，待发的移动报告会被
   *   **并进同一个字符串**（`移动报告 + 本条`），实测顺序见下。
   *
   * 🔴 为什么合并而不是「先 flush 一条、再发本条」：`ssh_input` 是两条独立的
   * Tauri 命令，后端各自拿 `writer` 的 std Mutex（`ssh_cmds.rs:2135`，非公平锁），
   * **两条命令的落盘顺序不保证**。分成两次 invoke，「先移到这里、再点一下」可能
   * 反过来，TUI 就会在旧坐标上执行点击。并成一个字符串后，顺序由字节流本身保证。
   */
  push(data: string): string | null;
  /** 立刻发出待发的移动报告（只走定时器之外的收尾路径）。 */
  flush(): void;
  dispose(): void;
}

export interface MotionThrottleOptions {
  intervalMs?: number;
  now?: () => number;
  /** 定时器注入（默认 setTimeout），单测用假时钟。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export function createMotionThrottle(
  send: (data: string) => void,
  opts: MotionThrottleOptions = {},
): MotionThrottle {
  const interval = opts.intervalMs ?? MOTION_MIN_INTERVAL_MS;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));

  let pending: string | null = null;
  let pendingKey = "";
  let lastSentKey = "";
  let lastSentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  /** 取走待发的移动报告（同时停掉定时器、更新去重基准）。没有则返回 `null`。 */
  const takePending = (): string | null => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (disposed || pending === null) return null;
    const data = pending;
    const key = pendingKey;
    pending = null;
    pendingKey = "";
    // 与上一条**已发出**的报告完全同格 ⇒ 远端看不出差别，直接丢。
    if (key === lastSentKey) return null;
    lastSentKey = key;
    lastSentAt = now();
    return data;
  };

  const flush = () => {
    const data = takePending();
    if (data !== null) send(data);
  };

  const schedule = () => {
    if (timer !== null || disposed) return;
    const wait = Math.max(0, interval - (now() - lastSentAt));
    timer = setTimer(() => {
      timer = null;
      flush();
    }, wait);
  };

  return {
    push(data: string): string | null {
      const report = parseMouseReport(data);
      if (!report || !isMotionReport(report)) {
        // 非移动事件：把「移到这里」并进同一条写入，顺序不依赖 IPC 调度。
        const prefix = takePending();
        // A click or a command can change the remote mouse mode without moving the pointer.
        // The next event at the same coordinates belongs to the new interaction.
        lastSentKey = "";
        return prefix === null ? data : prefix + data;
      }
      pending = data;
      pendingKey = `${report.button}:${report.x}:${report.y}:${report.final}`;
      // 距上一条已发出的超过一个窗口 ⇒ 立刻发，指针移动的响应不引入延迟。
      if (now() - lastSentAt >= interval) flush();
      else schedule();
      return null;
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
      pendingKey = "";
      disposed = true;
    },
  };
}
