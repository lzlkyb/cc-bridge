import { invoke } from "@tauri-apps/api/core";

/**
 * 界面异常上报（白屏取证的地基）。
 *
 * ## 为什么要有
 * release 版没有 devtools，`console.error` 在用户机器上等于抛进虚空。白屏到底是
 * **某个渲染路径抛错**（改代码）还是 **WebView2 渲染进程崩了**（重建 webview / 查内存），
 * 两者的修法完全相反——没有前端留下的证据就只能猜。
 *
 * ## 三条硬约束
 * 1. **自己绝不抛错**：上报失败必须静默。错误处理再制造一个错误是最糟的交换。
 * 2. **去重**：同一异常 60 秒内只报一次。渲染循环里同一个错误可能每帧抛一次，
 *    不挡住会瞬间把日志冲掉。
 * 3. **限长**：堆栈动辄几十 KB，截断后再发，别把 IPC 和日志一起撑爆。
 */

/** 同一异常的重报间隔。 */
const DEDUPE_MS = 60_000;

/** 单条明细上限（**UTF-8 字节**）。与后端 `ui_diag_cmds::MAX_FIELD` 同单位、同数值。 */
const MAX_DETAIL = 2000;

/** 截断标记。它自己也占字节预算，否则「截断后的正文 + 标记」会再超一次。 */
const TRUNCATED = "…（已截断）";

/** 去重表：`来源|消息 → 上次上报时刻`。 */
const seen = new Map<string, number>();

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    // 循环引用、getter 抛错之类。上报路径上不能有任何未捕获的异常。
    return String(error);
  }
}

function stackOf(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : "";
}

/**
 * 一个字符在**后端日志里**要占多少字节。
 *
 * 后端 `sanitize` 会把换行写成两个字符（换行 → `\n` 字面）、制表符换成空格、控制字符删掉。
 * 所以预算必须按「压平之后」算：一段堆栈在前端量着没超、到后端一压又多出几百字节，
 * 就会被截第二次，日志里出现两条「已截断」，而且中间那条标记可能被切成半截。
 */
function cost(ch: string): number {
  if (ch === "\n" || ch === "\r") return 2;
  if (ch === "\t") return 1;
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return 0;
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}

function costOf(text: string): number {
  let total = 0;
  for (const ch of text) total += cost(ch);
  return total;
}

/**
 * 按字节截断，且不切断多字节字符。
 *
 * 为什么按字节而不是字符：后端上限约束的是日志文件大小。按字符截断时，一段中文堆栈会以
 * 「2000 字符 ≈ 6000 字节」传过去，后端再截一次——白占一次传输，还留下两条截断标记。
 */
function truncate(text: string, maxBytes = MAX_DETAIL): string {
  const budget = maxBytes - costOf(TRUNCATED);
  let out = "";
  let used = 0;
  for (const ch of text) {
    const bytes = cost(ch);
    if (used + bytes > budget) {
      return out + TRUNCATED;
    }
    out += ch;
    used += bytes;
  }
  // 没超预算：原样返回（`out` 与 `text` 相同，省一次拼接）。
  return text;
}

/**
 * 上报一条界面异常。`extra` 用来补上下文（组件栈、URL、触发动作）。
 */
export function reportUiError(source: string, error: unknown, extra?: string): void {
  try {
    const message = describe(error);
    // 键含 source：同一句话在不同上报点（ErrorBoundary / onerror）出现时，多半是两条
    // 独立线索；只按 message 去重会把「另一个位置也炸了」这条信息吞掉。
    // 真正的重复（渲染循环里同一处反复抛）source 必然相同，仍然会被挡住。
    const key = `${source}|${message}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) {
      return;
    }
    // 只防表无限增长：旧签名早已过了去重窗口，清掉不影响判断。
    if (seen.size > 200) {
      seen.clear();
    }
    seen.set(key, now);

    const detail = truncate(
      [extra, stackOf(error)].filter((part): part is string => Boolean(part)).join("\n"),
    );
    void invoke("report_ui_error", { source, message, detail }).catch(() => {
      // IPC 没起来 / 窗口正在销毁：静默。日志写不进去不该变成用户可见的第二个问题。
    });
  } catch {
    /* 上报是尽力而为 */
  }
}

/**
 * 装上全局兜底，捕获 React 生命周期之外的异常。
 *
 * 放在 `main.tsx` 最顶部：`ErrorBoundary` 只管渲染期，事件回调、定时器、Promise
 * 里抛出的东西它一概看不到——而那些恰恰是最容易把界面打到白屏的一类。
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (event) => {
    const where =
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
    reportUiError("window.onerror", event.error ?? event.message, where);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportUiError("unhandledrejection", event.reason, "未处理的 Promise 拒绝");
  });
}

/** 仅测试用：清空去重表，避免用例之间互相压制。 */
export function __resetUiErrorDedupeForTests(): void {
  seen.clear();
}
