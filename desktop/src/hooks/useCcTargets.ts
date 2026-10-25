import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { SshConnectionList } from "../lib/types";

/** 一个「在哪跑」的选项：`id` 为空串 = 本机。 */
export type CcTarget = { id: string; label: string };

/**
 * 目标列表（本机 + 在用的 SSH 连接）。
 *
 * 宿主要它做分组头与历史区的副标题，每个 pane 自己也要它做目标下拉 ——
 * 两处都要同一条「显示名取 `name`，没有就退回 `host`」的规则。分开写的时候
 * 这两份一定漂（改了一边忘了另一边，表现是侧栏分组名和下拉里的名字不一样）。
 *
 * react-query 按 `queryKey` 去重：10 个 pane 也只会发一次请求。
 */
export function useCcTargets(): CcTarget[] {
  const { data } = useQuery<SshConnectionList, Error>({
    queryKey: ["sshConnections"],
    queryFn: () => invoke<SshConnectionList>("ssh_list_connections"),
  });
  return useMemo(
    () => [
      { id: "", label: "本机" },
      ...(data?.connections ?? []).map((c) => ({ id: c.id, label: c.name || c.host })),
    ],
    [data?.connections],
  );
}

/** 目标 id → 显示名。找不到时给「本机」（空 id 与未知 id 都落到这里）。 */
export function targetLabel(targets: CcTarget[], id: string | null | undefined): string {
  return targets.find((t) => t.id === (id ?? ""))?.label ?? "本机";
}
