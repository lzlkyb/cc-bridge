import { it, expect } from "vitest";
import { auditFilter, changeAuditFilter, type AuditView } from "./auditQuery";

it("keeps failure=false explicit and resets page only when changing conditions", () => {
  const view: AuditView = { page: 5, pageSize: 50, query: " legacy ", tool: "read_files", status: "error" };
  expect(auditFilter(view)).toEqual({ query: "legacy", tool: "read_files", success: false });
  expect(auditFilter({ ...view, page: 6 })).toEqual(auditFilter(view));
  expect(changeAuditFilter(view, { query: "old" })).toEqual({ ...view, query: "old", page: 1 });
  expect(auditFilter({ ...view, query: " ", tool: "", status: "all" })).toEqual({});
});
