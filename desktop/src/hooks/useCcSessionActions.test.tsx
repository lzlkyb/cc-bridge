// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCcSessionActions } from "./useCcSessionActions";
import { STORED_SESSIONS_KEY } from "./useCcPaneList";
import type { CcStoredSummary } from "../lib/ccEventTypes";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: h.invoke }));
let root: Root, qc: QueryClient, actions: ReturnType<typeof useCcSessionActions>;
const deleted = vi.fn();
function Probe() { actions = useCcSessionActions(deleted); return null; }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); h.invoke.mockReset(); deleted.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(STORED_SESSIONS_KEY, [{ rowId: 7, archivedAt: 100 }, { rowId: 8, archivedAt: null }]);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>));
});
afterEach(() => { act(() => root.unmount()); qc.clear(); vi.unstubAllGlobals(); });
it("取消归档明确覆盖本地旧缓存，不删除false状态", async () => {
  h.invoke.mockResolvedValue(undefined);
  await act(async () => actions.archive(7, false));
  expect(actions.archived[7]).toBe(false);
  expect(qc.getQueryData<CcStoredSummary[]>(STORED_SESSIONS_KEY)?.[0].archivedAt).toBeNull();
});
it("删除成功才摘页面与缓存，使用后端解析出的行号", async () => {
  const result = { rowId: 7, sessionIds: [12] }; h.invoke.mockResolvedValue(result);
  await act(async () => actions.remove(null, 12));
  expect(h.invoke).toHaveBeenCalledWith("cc_delete_session", { rowId: null, sessionId: 12 });
  expect(deleted).toHaveBeenCalledWith(result);
  expect(qc.getQueryData<CcStoredSummary[]>(STORED_SESSIONS_KEY)?.map(r => r.rowId)).toEqual([8]);
});
it("后端删除失败时保留页面和原记录", async () => {
  h.invoke.mockRejectedValue(new Error("database is locked"));
  await act(async () => { await expect(actions.remove(7)).rejects.toThrow("database is locked"); });
  expect(deleted).not.toHaveBeenCalled();
  expect(qc.getQueryData<CcStoredSummary[]>(STORED_SESSIONS_KEY)).toHaveLength(2);
});
