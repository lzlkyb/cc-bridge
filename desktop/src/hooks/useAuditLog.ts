import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import type { AuditPage } from "../lib/types";
import { auditFilter, changeAuditFilter, type AuditView } from "../lib/auditQuery";
import { useAppHidden } from "../lib/appVisibility";

const initial: AuditView = { page: 1, pageSize: 50, query: "", tool: "", status: "all" };

export function useAuditLog() {
  const [view, setView] = useState(initial);
  const [search, setSearch] = useState("");
  const appHidden = useAppHidden();
  // 输入立即显示，IPC 查询合并短时间内的键入；提交关键词和回到第一页同时发生。
  useEffect(() => {
    const timer = setTimeout(() => setView(v => v.query === search.trim() ? v : changeAuditFilter(v, { query: search.trim() })), 180);
    return () => clearTimeout(timer);
  }, [search]);
  const filter = useMemo(() => auditFilter(view), [view]);
  const query = useQuery<AuditPage>({
    queryKey: ["auditLog", view.page, view.pageSize, filter],
    queryFn: () => invoke<AuditPage>("get_audit_log", { page: view.page, page_size: view.pageSize, filter }),
    enabled: !appHidden,
    refetchInterval: appHidden ? false : 10000,
    placeholderData: previous => previous,
  });
  const setPage = useCallback((page: number) => setView(v => ({ ...v, page })), []);
  const setPageSize = useCallback((pageSize: number) => setView(v => ({ ...v, page: 1, pageSize })), []);
  const setToolFilter = useCallback((tool: string) => setView(v => changeAuditFilter(v, { tool })), []);
  const setStatusFilter = useCallback((status: AuditView["status"]) => setView(v => changeAuditFilter(v, { status })), []);
  const resetFilters = useCallback(() => { setSearch(""); setView(v => ({ ...initial, pageSize: v.pageSize })); }, []);
  return { ...query, ...view, filter, search, setSearch, setPage, setPageSize, setToolFilter, setStatusFilter, resetFilters, appHidden, pending: query.isFetching || search.trim() !== view.query };
}
