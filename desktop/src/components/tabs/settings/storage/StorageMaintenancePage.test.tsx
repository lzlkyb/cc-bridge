// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StorageMaintenancePage } from "./StorageMaintenancePage";
import { GIB, type CleanupRun, type StorageOverview, type StoragePreview } from "../../../../lib/storageMaintenance";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../../../lib/tauri", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("../../../../lib/appVisibility", () => ({ useAppHidden: () => false }));

const data: StorageOverview = {
  groups: [{ group: "logs", usedBytes: 4096, eligibleBytes: 3072 }, { group: "backup", usedBytes: 3 * GIB, eligibleBytes: 0 }],
  volume: { label: "C:", freeBytes: GIB, totalBytes: 40 * GIB },
  policy: { autoClean: true, dailyTime: "09:00", diskAlert: true, minFreeGb: 2, backupAlert: true, backupLimitGb: 2 },
  history: [], warnings: [], scannedAt: "2026-11-27T12:00:00+08:00",
};
const items: StoragePreview = { token: "test-plan", warnings: [], items: [
  { kind: "audit", bytes: 1024, count: 1, retentionDays: 30 },
  { kind: "relay", bytes: 2048, count: 1, retentionDays: 7 },
] };
let root: Root, host: HTMLDivElement, client: QueryClient;
const navigate = vi.fn();

function button(label: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label);
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
}

async function click(node: HTMLElement) {
  await act(async () => node.click());
  await settle();
}

async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><StorageMaintenancePage platform="windows" onNavigate={navigate} /></QueryClientProvider>));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  navigate.mockClear(); invoke.mockReset();
  invoke.mockImplementation(async (name, args) => {
    if (name === "get_storage_overview") return data;
    if (name === "preview_storage_cleanup") return items;
    if (name === "save_storage_policy") return args.policy;
    throw new Error(`Unexpected command: ${name}`);
  });
});

afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("displays distinct disk and backup warnings and links to backup management", async () => {
  await render();
  expect(host.textContent).toContain("C: 空间不足");
  expect(host.textContent).toContain("备份占用超过阈值");
  await click(button("管理备份"));
  expect(navigate).toHaveBeenCalledExactlyOnceWith("security", "set-backup");
  expect(invoke).not.toHaveBeenCalledWith("apply_storage_cleanup", expect.anything());
});

it("applies only checked categories to the issued preview and shows partial results", async () => {
  const result: CleanupRun = { at: data.scannedAt, source: "manual", freedBytes: 0, removedCount: 0, recorded: true,
    skipped: [{ kind: "relay", count: 1, reason: "文件已变化" }] };
  const mockedRead = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, args) => name === "apply_storage_cleanup" ? result : mockedRead(name, args));
  await render();
  await click(button("预览清理"));
  const choices = document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]');
  expect(choices).toHaveLength(2);
  await click(choices[0]);
  expect(document.querySelector(".sm-footer-total")?.textContent).toContain("2.0 KB");
  await click(button("确认清理"));
  expect(invoke).toHaveBeenCalledWith("apply_storage_cleanup", { token: "test-plan", kinds: ["relay"] });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("文件已变化");
  await click(button("预览重试"));
  expect(invoke.mock.calls.filter(([name]) => name === "preview_storage_cleanup")).toHaveLength(2);
  expect(document.querySelectorAll<HTMLInputElement>(".sm-preview-list input:checked")).toHaveLength(1);
});

it("keeps schedule changes local until saved and disables the run time when automatic cleanup is off", async () => {
  await render();
  await click(button("设置"));
  await click(document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动清理"]')!);
  expect(document.querySelector<HTMLInputElement>('input[type="time"]')?.disabled).toBe(true);
  expect(invoke).not.toHaveBeenCalledWith("save_storage_policy", expect.anything());
  await click(button("保存设置"));
  expect(invoke).toHaveBeenCalledWith("save_storage_policy", { policy: { ...data.policy, autoClean: false } });
  expect(host.querySelector(".sm-facts")?.textContent).toContain("已关闭");
});
