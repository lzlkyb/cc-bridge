import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { invoke } from "../lib/tauri";
import { toast } from "../components/ui/toast";
import {
  approvalStat,
  buildApprovalAudit,
  revertableFiles,
  type ApprovalFileChange,
  type ApprovalGroup,
  type ApprovalPoint,
  type CcSessionBackup,
} from "../lib/ccApprovalAudit";
import type { CcMessage } from "../lib/ccGuiTypes";

/**
 * 审批即审计（批 4-2）的数据与动作。
 *
 * ## 为什么只在面板打开时查
 *
 * 4-1 的上下文税面板必须常查（关着也要显示警示点）。这里没有那类「不看也要提醒」
 * 的信息：撤销入口只有打开面板才有意义。而审计是**追加写**，每次查都会缓存未命中、
 * 重解析整份 `audit.log` —— 常查等于每轮对话都白扫一遍。
 *
 * ## 撤销后为什么不重新查
 *
 * 撤销产生的审计条目挂的是 `restore_patch` / `restore_delete`，而且不归属任何
 * CC 对话会话（`ccSessionId` 为空），所以它不会出现在这份清单里。真正变的是
 * 「哪几个点已经被撤销」，那由本地状态记 —— 重新拉一遍结果一模一样。
 */

/** 一条改动的稳定 key（一个审批点可能改多个文件）。 */
export function revertKey(pointKey: string, path: string): string {
  return `${pointKey}::${path}`;
}

export function useCcApprovalAudit(args: {
  messages: CcMessage[];
  resolved: Record<string, { decision: "allow" | "deny"; auto?: boolean }>;
  cwd: string | null;
  /** **CC 的** session id（审计口径），不是 cc-bridge 内部 id。 */
  sessionId: string | null;
  /** 面板是否打开。关着就不查，理由见文件头。 */
  enabled: boolean;
}): {
  groups: ApprovalGroup[];
  stat: ReturnType<typeof approvalStat>;
  loading: boolean;
  /** 正在撤销的那条（`revertKey`），用于禁用与转圈。 */
  busyKey: string | null;
  /** 已经撤销掉的（`revertKey` → true）。 */
  reverted: Record<string, true>;
  revertOne: (point: ApprovalPoint, file: ApprovalFileChange) => Promise<boolean>;
  revertGroup: (group: ApprovalGroup) => Promise<void>;
} {
  const { messages, resolved, cwd, sessionId, enabled } = args;
  const [reverted, setReverted] = useState<Record<string, true>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const backups = useQuery({
    queryKey: ["cc-session-backups", sessionId],
    queryFn: () => invoke<CcSessionBackup[]>("cc_session_backups", { sessionId: sessionId! }),
    enabled: enabled && !!sessionId,
    // 审计是追加写，缓存下来的清单随时会过期；只在这个 key 打开时查一次就够。
    staleTime: 0,
    retry: false,
  });

  const groups = useMemo(() => {
    // 面板关着就不算：`buildApprovalAudit` 要遍历整条流水并算 diff，
    // 流式期间每帧跑一遍纯属浪费（而结果只在打开的那一刻才被看见）。
    if (!enabled) return [] as ApprovalGroup[];
    return buildApprovalAudit(messages, resolved, backups.data ?? [], cwd);
  }, [enabled, messages, resolved, backups.data, cwd]);

  /** 返回是否成功：整组撤销靠它决定要不要继续（成功的判断不能读 state —— 那是上一轮渲染的值）。 */
  const revertOne = useCallback(
    async (point: ApprovalPoint, file: ApprovalFileChange): Promise<boolean> => {
      const key = revertKey(point.key, file.path);
      setBusyKey(key);
      try {
        if (file.revert === "backup") {
          await invoke("restore_file", {
            backup_path: file.backupPath,
            target_path: file.path,
          });
        } else if (file.revert === "patch") {
          await invoke("restore_edit_patch", {
            targetPath: file.path,
            patches: (file.patches ?? []).map((p) => ({
              oldString: p.oldString,
              newString: p.newString,
            })),
          });
        } else if (file.revert === "delete-created") {
          await invoke("restore_delete_created", {
            targetPath: file.path,
            expectedContent: file.writtenContent ?? "",
          });
        } else {
          return false;
        }
        setReverted((m) => ({ ...m, [key]: true }));
        toast("已撤销这次改动（撤销前的版本已备份，可再还原）", "success");
        return true;
      } catch (e) {
        // 后端拒绝时说的是「哪一处对不上、文件未改动」，原样透出去 —— 那句话本身就是
        // 用户判断下一步的依据，包一层反而看不清。
        toast(String(e), "error");
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [],
  );

  const revertGroup = useCallback(
    async (group: ApprovalGroup) => {
      // 串行：同一文件的几处撤销有先后依赖，并发只会互相踩。
      // 一条失败就停 —— 继续撤后面几条会让「撤到一半」的状态更难解释。
      for (const point of group.points) {
        for (const file of revertableFiles(point)) {
          if (reverted[revertKey(point.key, file.path)]) continue;
          const ok = await revertOne(point, file);
          if (!ok) return;
        }
      }
    },
    [reverted, revertOne],
  );

  return {
    groups,
    stat: approvalStat(groups),
    loading: backups.isFetching,
    busyKey,
    reverted,
    revertOne,
    revertGroup,
  };
}
