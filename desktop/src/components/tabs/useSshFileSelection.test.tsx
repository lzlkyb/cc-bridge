// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSshFileSelection } from "./useSshFileSelection";
import type { SshFileEntry } from "../../lib/types";

const entries: SshFileEntry[] = [
  { name: "a.txt", isDir: false, isSymlink: false, size: 1, mtime: 0 },
  { name: "b.txt", isDir: false, isSymlink: false, size: 2, mtime: 0 },
  { name: "c.txt", isDir: false, isSymlink: false, size: 3, mtime: 0 },
  { name: "sub", isDir: true, isSymlink: false, size: 0, mtime: 0 },
];

const h = vi.hoisted(() => ({ download: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useSshFileSelection>;
function Probe() {
  api = useSshFileSelection({ entries, onDownload: h.download, busy: false });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("Ctrl/⌘+点击切换单个选中，普通点击只选中一个", async () => {
  await act(async () => api.pick("a.txt", {}));
  expect(api.selected).toEqual(["a.txt"]);
  await act(async () => api.pick("b.txt", { ctrlKey: true }));
  expect(api.selected).toEqual(["a.txt", "b.txt"]);
  await act(async () => api.pick("a.txt", { metaKey: true }));
  expect(api.selected).toEqual(["b.txt"]);
  await act(async () => api.pick("c.txt", {}));
  expect(api.selected).toEqual(["c.txt"]);
});

it("Shift+点击选一段（从锚点到当前行）", async () => {
  await act(async () => api.pick("a.txt", {}));
  await act(async () => api.pick("c.txt", { shiftKey: true }));
  expect(api.selected).toEqual(["a.txt", "b.txt", "c.txt"]);
});

it("批量下载只发文件，不发目录（目录没有「下载」这回事）", async () => {
  await act(async () => api.selectAll());
  expect(api.selected).toHaveLength(4);
  await act(async () => api.downloadSelected());
  expect(h.download.mock.calls.map((c) => c[0])).toEqual(["a.txt", "b.txt", "c.txt"]);
});

it("下载队列等待前一文件完成，不并发弹选择器，重复点击不重复排队", async () => {
  let finish!: () => void;
  h.download.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => api.selectAll());
  let queue!: Promise<void>;
  act(() => { queue = api.downloadSelected(); });
  expect(h.download.mock.calls.map(call => call[0])).toEqual(["a.txt"]);
  await act(async () => api.downloadSelected());
  expect(h.download).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); await queue; });
  expect(h.download.mock.calls.map(call => call[0])).toEqual(["a.txt", "b.txt", "c.txt"]);
});

it("面板卸载后不再启动队列中的后续下载", async () => {
  let finish!: () => void;
  h.download.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => api.selectAll());
  let queue!: Promise<void>;
  act(() => { queue = api.downloadSelected(); });
  await act(async () => root.render(null));
  await act(async () => { finish(); await queue; });
  expect(h.download.mock.calls.map(call => call[0])).toEqual(["a.txt"]);
});

it("批量删除清单排除目录：递归删目录不能混在批量里", async () => {
  await act(async () => api.selectAll());
  expect(api.deletable.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
});

it("busy 时批量下载被拦（并发 ssh 握手成本乘以 N）", async () => {
  const busyRoot = createRoot(document.createElement("div"));
  function BusyProbe() {
    api = useSshFileSelection({ entries, onDownload: h.download, busy: true });
    return null;
  }
  await act(async () => busyRoot.render(<BusyProbe />));
  await act(async () => api.selectAll());
  await act(async () => api.downloadSelected());
  expect(h.download).not.toHaveBeenCalled();
  await act(async () => busyRoot.unmount());
});

it("clear 清空选择与锚点", async () => {
  await act(async () => api.selectAll());
  await act(async () => api.clear());
  expect(api.selected).toEqual([]);
  await act(async () => api.pick("c.txt", { shiftKey: true }));
  // 锚点已清：Shift+点击不该把整段都选上
  expect(api.selected).toEqual(["c.txt"]);
});
