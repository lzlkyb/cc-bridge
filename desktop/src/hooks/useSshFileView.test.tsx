// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSshFileView } from "./useSshFileView";
import type { SshFileEntry } from "../lib/types";

const entry = (name: string, isDir = false, size = 0, mtime = 0): SshFileEntry =>
  ({ name, isDir, isSymlink: false, size, mtime });

/** 服务器原始序（刻意打乱：断言必须能看出排序真的发生了）。 */
const raw: SshFileEntry[] = [
  entry("zebra.txt", false, 30, 300),
  entry("apple.txt", false, 10, 100),
  entry("docs", true, 0, 0),
  entry("Beta.txt", false, 20, 200),
];

let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useSshFileView>;
const currentPath = "/a";
function Probe({ entries = raw, path = currentPath }: { entries?: SshFileEntry[]; path?: string }) {  api = useSshFileView(entries, path);
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

it("默认排序：目录恒优先 + 名称升序（与列目录现状一致，不引入新心智）", async () => {
  expect(api.items.map((e) => e.name)).toEqual(["docs", "apple.txt", "Beta.txt", "zebra.txt"]);
  expect(api.sort).toEqual({ key: "name", dir: "asc" });
});

it("表头轮换：换列降序 → 同列升序 → 再点回默认", async () => {
  await act(async () => api.toggleSort("size"));
  expect(api.sort).toEqual({ key: "size", dir: "desc" });
  expect(api.items.map((e) => e.name)).toEqual(["docs", "zebra.txt", "Beta.txt", "apple.txt"]);
  await act(async () => api.toggleSort("size"));
  expect(api.sort).toEqual({ key: "size", dir: "asc" });
  expect(api.items.map((e) => e.name)).toEqual(["docs", "apple.txt", "Beta.txt", "zebra.txt"]);
  await act(async () => api.toggleSort("size"));
  expect(api.sort).toEqual({ key: "name", dir: "asc" });   // 回默认，不是停在升序
});

it("过滤：大小写不敏感、目录一起过滤、空词不过滤", async () => {
  await act(async () => api.setQuery("beta"));
  expect(api.items.map((e) => e.name)).toEqual(["Beta.txt"]);
  await act(async () => api.setQuery("doc"));
  expect(api.items.map((e) => e.name)).toEqual(["docs"]);   // 目录名命中也显示
  await act(async () => api.setQuery("   "));
  expect(api.items).toHaveLength(4);                        // 纯空白 = 不过滤
});

it("🔴 换目录清空过滤词（上个目录的词会列出一小堆，让人以为文件丢了）；排序偏好保留", async () => {
  await act(async () => api.toggleSort("mtime"));
  await act(async () => api.setQuery("apple"));
  expect(api.items.map((e) => e.name)).toEqual(["apple.txt"]);
  // 换目录：同一个 act 里 query 必须已经清零（渲染期重置，不靠 effect 补救）
  await act(async () => root.render(<Probe path="/b" />));
  expect(api.query).toBe("");
  expect(api.items.map((e) => e.name)).toEqual(["docs", "zebra.txt", "Beta.txt", "apple.txt"]);
  expect(api.sort).toEqual({ key: "mtime", dir: "desc" });  // 排序偏好跨目录保留
});

it("排序/过滤不改入参（快照是共享缓存，原地 sort 会污染别的视图）", async () => {
  await act(async () => api.toggleSort("size"));
  await act(async () => api.setQuery("txt"));
  expect(raw.map((e) => e.name)).toEqual(["zebra.txt", "apple.txt", "docs", "Beta.txt"]);
});
