import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import { STORED_SESSIONS_KEY } from "./useCcPaneList";

/**
 * 侧栏的改名 / 归档（3-1d）。
 *
 * ## 为什么手写标题要在前端留一份
 *
 * 一条**打开着的**会话，侧栏标题是前端按「首条用户消息」现算的（`ccPaneMeta`）。
 * 改名写进库里之后，那条消息还在，现算出来的标题当然还是旧的 —— 不覆盖的话
 * 用户改完名字看不到任何变化（而历史区那条已经变了），像是只改了一半。
 *
 * 所以这里存一份 `rowId → 手写标题`，由宿主编进 `titleOverride` 往下传：
 * - 本窗口刚改的 ⇒ 立刻生效；
 * - 重启之后 ⇒ `cc_restore` 带回 `titleLocked` + `title`，同样生效（见 `CcPane`）。
 *
 * 键用 `rowId` 而不是 pane 的 key：同一个 pane 的 key 不变，但「这一行」是
 * 库里的实体，改名与归档都按它寻址。
 *
 * ## 为什么错误往外抛
 *
 * 「这条会话已经不在库里了」是用户能据此行动的信息（刷新列表），必须显示在
 * 点下去的那个菜单里。吞掉只会让改名看起来成功了。
 */
export function useCcSessionActions() {
  const qc = useQueryClient();
  const [titles, setTitles] = useState<Record<number, string>>({});

  const rename = useCallback(
    async (rowId: number, title: string) => {
      const saved = await invoke<string>("cc_rename_session", { rowId, title });
      setTitles((m) => ({ ...m, [rowId]: saved }));
      // 历史区里那条的标题也要跟着变（它读的是库）。
      await qc.invalidateQueries({ queryKey: STORED_SESSIONS_KEY });
      return saved;
    },
    [qc],
  );

  const archive = useCallback(
    async (rowId: number, archived: boolean) => {
      await invoke<void>("cc_archive_session", { rowId, archived });
      // 归档 / 取消归档会同时影响「历史」与「已归档」两批，一次失效就够。
      await qc.invalidateQueries({ queryKey: STORED_SESSIONS_KEY });
    },
    [qc],
  );

  return { titles, rename, archive };
}
