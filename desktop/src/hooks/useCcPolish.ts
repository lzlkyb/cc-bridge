import { useCallback } from "react";
import { invoke } from "../lib/tauri";

/**
 * 草稿润色（`mods/prompt-polish` 的后端半边，命令是 `cc_polish`）。
 *
 * ## 为什么走独立命令而不是会话里的一句话
 *
 * 润色是**界面的辅助动作**：不该进事件流水、不占会话上下文、不该让模型「记得」
 * 用户改写过草稿。后端那边是一次性的 `claude -p --bare` 子进程，结果只回给输入框。
 *
 * ## 为什么失败返回 `null` 而不是抛
 *
 * 调用方（`Composer`）拿到 `null` 就保持原文不动 —— 润色挂了不该让用户丢掉
 * 已经写好的草稿。原因转成对话流里的一条 notice（`reportError`），
 * 因为输入区自己在编辑时不能弹浮层。
 */
export function useCcPolish({
  connectionId,
  cwd,
  reportError,
}: {
  /** 空串 = 本机。润色要在**同一个目标**上跑：远端目录本机不存在。 */
  connectionId: string;
  cwd: string;
  reportError: (message: string) => void;
}) {
  return useCallback(
    async (draft: string): Promise<string | null> => {
      try {
        return await invoke<string>("cc_polish", {
          req: {
            connectionId: connectionId || null,
            cwd: cwd.trim() || null,
            draft,
          },
        });
      } catch (e) {
        reportError(`润色失败：${e}`);
        return null;
      }
    },
    [connectionId, cwd, reportError],
  );
}
