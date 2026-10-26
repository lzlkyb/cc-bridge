/**
 * 把一段对话拼成 Markdown（纯函数）。
 *
 * 用途只有一个：**带走**。贴进 issue、存成笔记、交给另一个模型 —— 单条消息
 * 各自有复制按钮，但整段要逐条点，实际没人会那么干。
 *
 * ## 刻意不导出什么
 *
 * - **diff**（`Edit` / `Write` 的改动内容）：那是过程，不是结论。一次重构三十次
 *    Edit，全导出来是几 MB 的补丁，反而没人看。只留「改了哪个文件、改了几处」。
 * - **`Read` 的入参 JSON**：`{"file_path": "/..."}` 对读的人没有信息量。
 * - **审批卡**：它是一次交互的凭据，不是对话内容。
 *
 * 保留 `Bash` 的命令与输出：那是「凭什么得出这个结论」的唯一证据。
 */

import type { CcMessage, CcToolCall } from "./ccGuiTypes";
import { editCount, toolArgLabel, toolBodyText, toolKind } from "../components/ccgui/summarize";

export type ExportMeta = {
  /** 会话标题（用户手写的，或按首条消息现算的那一个）。 */
  title: string;
  cwd: string;
  model: string;
  /** 导出时间。由调用方给：纯函数里读 `Date.now()` 就没法测了。 */
  at: string;
};

/**
 * 代码块围栏：**比内容里最长的反引号串多一层**。
 *
 * 工具输出里出现三反引号是常事（`cat README.md`），固定用 ``` 包会把代码块
 * 提前闭合，后面整段变成散落的普通文字 —— 而且看起来像是导出坏了。
 */
function fence(text: string): string {
  let n = 3;
  for (const m of text.matchAll(/`+/g)) n = Math.max(n, m[0].length + 1);
  const f = "`".repeat(n);
  return `${f}\n${text}\n${f}`;
}

function toolSection(tool: CcToolCall): string[] {
  const kind = toolKind(tool.name);
  const label = toolArgLabel(tool.input);
  const head = `### \`${tool.name}\`${label ? ` ${label}` : ""}`;

  if (kind === "edit" || kind === "write") {
    const what = kind === "write" ? "整体写入" : `${editCount(tool.input)} 处修改`;
    return [head, "", `（${what}，diff 见会话记录）`];
  }
  // `read` 的 body 是入参 JSON（`file_path`），对读的人没有信息量。
  const body = kind === "read" ? null : toolBodyText(tool);
  return body ? [head, "", fence(body)] : [head];
}

/** 一条消息里能出现在导出中的正文（`null` = 这条不占位置）。 */
export function conversationMarkdown(messages: CcMessage[], meta: ExportMeta): string {
  const out: string[] = [];
  const facts = [
    meta.cwd ? `- 目录：\`${meta.cwd}\`` : "",
    meta.model ? `- 模型：${meta.model}` : "",
    `- 导出时间：${meta.at}`,
  ].filter(Boolean);

  out.push(`# ${meta.title.trim() || "对话"}`, "", ...facts, "");

  for (const m of messages) {
    switch (m.kind) {
      case "user":
        out.push("---", "", "## 我", "", m.text);
        // 图只有缩略图（原图不落盘），导出里放不进去 —— 至少要说明这条带过图，
        // 否则读的人会以为上面那段话就是全部。
        if (m.images?.length) out.push("", `（附 ${m.images.length} 张图，原图未保留）`);
        out.push("");
        break;
      case "assistant":
        out.push("---", "", "## CC", "", m.text, "");
        break;
      case "thinking":
        // 折叠起来：它是「还活着」的证据，不是结论。摊开会把正文冲散。
        out.push("<details><summary>思考过程</summary>", "", m.text, "", "</details>", "");
        break;
      case "tool":
        out.push(...toolSection(m.tool), "");
        break;
      default:
        // 审批 / 提问卡：一次交互的凭据，不是对话内容。
        break;
    }
  }

  // 连续三条以上的空行压成两条：工具段末尾与下一段开头都会各留一行。
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
