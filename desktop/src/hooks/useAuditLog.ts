import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "../lib/tauri";
import type { AuditPage } from "../lib/types";
import { auditFilter, changeAuditFilter, type AuditView } from "../lib/auditQuery";
import { useAppHidden } from "../lib/appVisibility";

const initial: AuditView = { page: 1, pageSize: 50, query: "", tool: "", status: "all" };

export function useAuditLog() {
  const [view, setView] = useState(initial);
  const [search, setSearch] = useState("");
  const appHidden = useAppHidden();
  const queryClient = useQueryClient();
  // 输入立即显示，IPC 查询合并短时间内的键入；提交关键词和回到第一页同时发生。
  useEffect(() => {
    const timer = setTimeout(() => setView(v => v.query === search.trim() ? v : changeAuditFilter(v, { query: search.trim() })), 180);
    return () => clearTimeout(timer);
  }, [search]);
  const filter = useMemo(() => auditFilter(view), [view]);

  // 事件驱动：后端每条审计落盘 emit `audit:appended`（audit.rs 单一漏斗），前端
  // 即时失效缓存 —— 日志页从「10s 一刷」变成逐条活起来。500ms 防抖收敛突发
  // （batch / 高频工具调用时一次失效顶一串事件，Rust 侧整份重解析不该按事件数走）。
  // 窗口隐藏时不失效（规则 8）：恢复可见后由轮询/焦点刷新补上。
  useEffect(() => {
    if (appHidden) return;
    let un: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void listen("audit:appended", () => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["auditLog"] });
        void queryClient.invalidateQueries({ queryKey: ["auditLogPerf"] });
      }, 500);
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
      if (timer != null) clearTimeout(timer);
    };
  }, [appHidden, queryClient]);

  // 轮询降级为 60s 兜底：主刷新已是事件驱动，这里只防事件丢失的尾部场景。
  const query = useQuery<AuditPage>({
    queryKey: ["auditLog", view.page, view.pageSize, filter],
    queryFn: () => invoke<AuditPage>("get_audit_log", { page: view.page, page_size: view.pageSize, filter }),
    enabled: !appHidden,
    refetchInterval: appHidden ? false : 60000,
    placeholderData: previous => previous,
  });
  const setPage = useCallback((page: number) => setView(v => ({ ...v, page })), []);
  const setPageSize = useCallback((pageSize: number) => setView(v => ({ ...v, page: 1, pageSize })), []);
  const setToolFilter = useCallback((tool: string) => setView(v => changeAuditFilter(v, { tool })), []);
  const setStatusFilter = useCallback((status: AuditView["status"]) => setView(v => changeAuditFilter(v, { status })), []);
  const resetFilters = useCallback(() => { setSearch(""); setView(v => ({ ...initial, pageSize: v.pageSize })); }, []);
  return { ...query, ...view, filter, search, setSearch, setPage, setPageSize, setToolFilter, setStatusFilter, resetFilters, appHidden, pending: query.isFetching || search.trim() !== view.query };
}
