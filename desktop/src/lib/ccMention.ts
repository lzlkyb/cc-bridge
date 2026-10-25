/**
 * @引用补全的纯函数层（设计稿《对话页-@引用与排版偏好-2026-10-26》）。
 *
 * token 判定与主流编辑器一致：光标前最近的 `@`，且 @ 前是行首/空白
 * （`a@b` 是邮箱不是引用）；token 内出现空白 = 引用已结束。
 * 状态机与取数在 `hooks/useCcMention.ts`，这里只放可单测的推导。
 */

/** 面板条目。本地（browse_directory）与远端（ssh_sftp_list）两种来源映射到同一形状。 */
export type MentionItem = {
  name: string;
  path: string;
  isDir: boolean;
  /** 远端条目带大小（字节），本地没有。 */
  size?: number;
  /** 根层的角标（如「本会话目录」）。 */
  tag?: string;
};

/** 光标处的 @token。`start` 是 @ 的下标，`query` 是 @ 之后已输入的文本。 */
export type MentionToken = { start: number; query: string };

export function mentionTokenOf(value: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > value.length) return null;
  const head = value.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at < 0) return null;
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return null;
  if (at > 0 && !/\s/.test(value[at - 1])) return null;
  return { start: at, query };
}

/** 选中项写回：把 [start, caret) 的 token 换成 `@<path><suffix>`。
 *  目录 suffix="/"（续打下一层，面板继续）；文件 suffix=" "（引用完成，面板自然关）。 */
export function insertMention(value: string, start: number, caret: number, path: string, suffix: string): string {
  return `${value.slice(0, start)}@${path}${suffix}${value.slice(caret)}`;
}

/** 查询的路径段（两种分隔符都认，Windows 反斜杠照打也能下钻）。 */
export function typedSegments(query: string): string[] {
  return query.split(/[\\/]+/).filter(Boolean);
}

/** 远端子路径拼接：ssh_sftp_list 的条目只有名字（可能带 ` -> 链接目标` 后缀），路径自己拼。 */
export function remoteChildPath(dir: string, name: string): string {
  const clean = name.replace(/ -> .*$/, "");
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${base}/${clean}`;
}

/** 当前层过滤。**不重排序**：本地后端已按「目录在前、名字序」排好，根层的
 *  「本会话目录置顶」是有意为之 —— 这里再排一次会把置顶打散（远端排序在
 *  `useCcMention.listDir` 的映射处做，同一契约）。 */
export function filterMentionItems(items: MentionItem[], filter: string): MentionItem[] {
  const f = filter.trim().toLowerCase();
  return items.filter((it) => !f || it.name.toLowerCase().includes(f));
}
