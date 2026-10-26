import { useSyncExternalStore } from "react";

/**
 * 对话详略档位（详细 / 标准 / 精简）：决定**元信息层**摊开多少。
 *
 * 三档只改两件事的默认展开态，不改任何内容是否**存在**：
 *
 * | 档位 | 思考块 | 工具行 |
 * |---|---|---|
 * | 详细 | 默认展开全文 | 有内容就展开（含 Read / 其它工具的入参 JSON） |
 * | 标准 | 折叠成一行摘要 | Edit/Write 展开、Bash 有输出展开、其余折叠（改动前的行为） |
 * | 精简 | 折叠成一行摘要 | 全部折叠（只留一行「名字 + 参数摘要 + 耗时/±」） |
 *
 * 🔴 **为什么三档都不隐藏思考块那一行**：会话内搜索的命中口径
 * （`summarize.ts::convSegments`）把思考标题算作可见文本，而那条口径的硬约束是
 * 「计数说命中、界面上必须找得到」。整块藏掉就会变成「搜到 3 处、屏幕上一处
 * 都没有」，这是 2026-10-25 会话内搜索专门堵过的分裂。折叠行保住了这条一致性。
 *
 * 与 `chatTypography` / `diffView` 同构：模块级 store + `useSyncExternalStore`，
 * localStorage 全局记忆（跨 pane、跨重启），不穿 props 链 —— 一条长会话里几十个
 * 工具卡各订阅各的，切档时一次性全部重算，不需要宿主逐层传。
 *
 * 默认 `n`（标准）= 改动前的行为，不给老用户换默认。
 */

export type ChatVerbosity = "v" | "n" | "c";

export const CHAT_VERBOSITY: Record<ChatVerbosity, { label: string; hint: string }> = {
  v: { label: "详细", hint: "思考与工具全部展开" },
  n: { label: "标准", hint: "思考折叠；编辑与命令结果自动展开" },
  c: { label: "精简", hint: "思考折叠；工具只留一行摘要" },
};

const KEY = "ccbridge_chat_verbosity";
const ORDER: ChatVerbosity[] = ["v", "n", "c"];

function read(): ChatVerbosity {
  try {
    const v = localStorage.getItem(KEY);
    return v === "v" || v === "c" ? v : "n";
  } catch {
    return "n";
  }
}

let current: ChatVerbosity = read();
const listeners = new Set<() => void>();

function write(next: ChatVerbosity) {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 存不进只丢「跨重启记忆」，本窗口内仍即时生效
  }
  listeners.forEach((f) => f());
}

/** 详略钮：详细 → 标准 → 精简 循环。 */
export function cycleChatVerbosity(): ChatVerbosity {
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  write(next);
  return next;
}

/** 直接置某一档（命令面板 / 设置页用）。同值不触发重渲。 */
export function setChatVerbosity(next: ChatVerbosity): void {
  if (next !== current) write(next);
}

export function useChatVerbosity(): ChatVerbosity {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
