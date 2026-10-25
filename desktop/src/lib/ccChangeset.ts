/**
 * 变更集：本会话改过的文件（批 2-3）。
 *
 * 🔴 走会话事件流聚合，**不查 git**：git 只知道「工作区现在和 HEAD 的差」，
 *    而对话中途 CC 可能已经改回去、也可能改了没落盘；用户问的是「这一轮对话
 *    它动过哪些文件」。事件流是唯一同时知道「谁动的、成功没有、在流里的位置」
 *    来源——位置还能直接拿来跳转到对应 diff。
 *
 * 口径：只数会落盘的 built-in 工具（Edit / MultiEdit / NotebookEdit / Write）。
 * Bash 里的 `sed -i` 看不出来也不猜——猜错的「变更集」比没有更糟。
 */

import type { CcMessage } from "./ccGuiTypes";

export type ChangesetEntry = {
  /** 完整路径（title 用）。 */
  path: string;
  /** 展示用短名：路径后两段，避免绝对路径把面板撑爆。 */
  label: string;
  /** 改动次数（同一文件多次 Edit/Write 计多次）。 */
  edits: number;
  /** 其中失败的次数。>0 时面板要显式警示——失败的那次可能什么都没改成。 */
  failed: number;
  /** 第一次改动就是 Write ⇒ 这个文件是本会话新建的。 */
  created: boolean;
  /** 第一次改动那条工具消息的 id（跳转目标）。 */
  messageId: string;
};

/** 与 `summarize.ts` 的 EXACT 表对齐：那边管渲染分流，这边管聚合口径。 */
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);

/** 改文件工具的入参里放路径的键。NotebookEdit 用 `notebook_path`，不列就漏。 */
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

function readPath(input: Record<string, unknown>): string {
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 短名：后两段。只有一个段（罕见）就它本身。 */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

/**
 * 聚合本会话的改文件事件。按**首次出现顺序**返回（对话顺序，不是字典序）——
 * 回看时按「先改什么后改什么」对得上记忆。
 *
 * 跳转目标是首次改动：那块 diff 诞生的地方，后续同文件的改动都排在它下面。
 */
export function collectChangeset(messages: CcMessage[]): ChangesetEntry[] {
  const byPath = new Map<string, ChangesetEntry>();
  const order: string[] = [];
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    const { tool } = m;
    if (!FILE_TOOLS.has(tool.name)) continue;
    const path = readPath(tool.input);
    if (!path) continue;
    const failed = tool.status === "error" || tool.isError === true;
    const cur = byPath.get(path);
    if (!cur) {
      byPath.set(path, {
        path,
        label: shortPath(path),
        edits: 1,
        failed: failed ? 1 : 0,
        created: tool.name === "Write",
        messageId: m.id,
      });
      order.push(path);
    } else {
      cur.edits += 1;
      if (failed) cur.failed += 1;
    }
  }
  return order.map((p) => byPath.get(p)!);
}

/** 面板头部的一行汇总。空列表时三项全 0。 */
export function changesetStat(entries: ChangesetEntry[]): {
  files: number;
  edits: number;
  failed: number;
} {
  return {
    files: entries.length,
    edits: entries.reduce((a, e) => a + e.edits, 0),
    failed: entries.reduce((a, e) => a + e.failed, 0),
  };
}
