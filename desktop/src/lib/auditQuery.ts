export interface AuditFilter {
  query?: string;
  tool?: string;
  success?: boolean;
}

export interface AuditView {
  page: number;
  pageSize: number;
  query: string;
  tool: string;
  status: "all" | "success" | "error";
}

export function auditFilter(view: AuditView): AuditFilter {
  return {
    ...(view.query.trim() ? { query: view.query.trim() } : {}),
    ...(view.tool ? { tool: view.tool } : {}),
    ...(view.status !== "all" ? { success: view.status === "success" } : {}),
  };
}

export function changeAuditFilter(view: AuditView, patch: Partial<Pick<AuditView, "query" | "tool" | "status">>): AuditView {
  return { ...view, ...patch, page: 1 };
}
