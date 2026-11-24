import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  filterEntries,
  nextSortState,
  sortEntries,
  type SortKey,
  type SortState,
} from "./sshFileSort";
import type { SshFileEntry } from "./types";

const file = (
  name: string,
  opts: Partial<Pick<SshFileEntry, "isDir" | "size" | "mtime">> = {},
): SshFileEntry => ({ name, isDir: false, isSymlink: false, size: 0, mtime: 0, ...opts });

const names = (entries: SshFileEntry[]) => entries.map((e) => e.name);

describe("sortEntries", () => {
  it("默认排序：目录优先 + 名称升序", () => {
    const input = [file("z.txt"), file("app", { isDir: true }), file("a.txt"), file("logs", { isDir: true })];
    expect(names(sortEntries(input, DEFAULT_SORT))).toEqual(["app", "logs", "a.txt", "z.txt"]);
  });

  it("目录优先在任何列、任何方向下都生效", () => {
    const input = [
      file("small.txt", { size: 1 }),
      file("adir", { isDir: true, size: 999 }),
      file("big.txt", { size: 100 }),
      file("zdir", { isDir: true, size: 0 }),
    ];
    expect(names(sortEntries(input, { key: "size", dir: "desc" }))).toEqual([
      "adir",
      "zdir",
      "big.txt",
      "small.txt",
    ]);
    expect(names(sortEntries(input, { key: "size", dir: "asc" }))).toEqual([
      "adir",
      "zdir",
      "small.txt",
      "big.txt",
    ]);
    // 名称列降序时目录块同样不翻面：组内恒升序（设计稿「目录仍在顶部」），
    // 主列与方向只作用于文件（文件则是名称降序：small 在 big 前）。
    expect(names(sortEntries(input, { key: "name", dir: "desc" }))).toEqual([
      "adir",
      "zdir",
      "small.txt",
      "big.txt",
    ]);
  });

  it("同值按名称次级排序（升序，不随主方向翻面）", () => {
    const input = [file("c.txt", { size: 5 }), file("a.txt", { size: 5 }), file("b.txt", { size: 5 })];
    expect(names(sortEntries(input, { key: "size", dir: "desc" }))).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(names(sortEntries(input, { key: "size", dir: "asc" }))).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("修改时间排序与大小同构", () => {
    const input = [file("old", { mtime: 100 }), file("new", { mtime: 900 })];
    expect(names(sortEntries(input, { key: "mtime", dir: "desc" }))).toEqual(["new", "old"]);
    expect(names(sortEntries(input, { key: "mtime", dir: "asc" }))).toEqual(["old", "new"]);
  });

  it("软链条目按 isDir 归类（软链到目录的 isDir=false，与 readdir 的 lstat 语义一致）", () => {
    const link = file("link-to-dir", { isDir: false, mtime: 5 });
    const dir = file("real-dir", { isDir: true, mtime: 1 });
    expect(names(sortEntries([link, dir], DEFAULT_SORT))).toEqual(["real-dir", "link-to-dir"]);
  });

  it("不改入参（返回新数组）", () => {
    const input = [file("b"), file("a")];
    const out = sortEntries(input, DEFAULT_SORT);
    expect(out).not.toBe(input);
    expect(names(input)).toEqual(["b", "a"]);
  });
});

describe("nextSortState", () => {
  const cycle = (start: SortState, key: SortKey, times: number): SortState => {
    let cur = start;
    for (let i = 0; i < times; i++) cur = nextSortState(cur, key);
    return cur;
  };

  it("首次点某列 = 降序；再点 = 升序；第三次 = 回默认", () => {
    expect(nextSortState(DEFAULT_SORT, "size")).toEqual({ key: "size", dir: "desc" });
    expect(cycle(DEFAULT_SORT, "size", 2)).toEqual({ key: "size", dir: "asc" });
    expect(cycle(DEFAULT_SORT, "size", 3)).toEqual(DEFAULT_SORT);
  });

  it("🔴 名称列是默认列：首次点击也降序（不能因「默认即名称升序」变成空操作）", () => {
    expect(nextSortState(DEFAULT_SORT, "name")).toEqual({ key: "name", dir: "desc" });
    expect(cycle(DEFAULT_SORT, "name", 2)).toEqual({ key: "name", dir: "asc" });
    // 升序 ≡ 默认态，再点翻面回降序：名称列的「回到默认」就是第二次点击本身，
    // 轮换在 desc/asc 之间翻转（纯函数分不开「轮到升序」与「本就停在默认」）。
    expect(cycle(DEFAULT_SORT, "name", 3)).toEqual({ key: "name", dir: "desc" });
  });

  it("从其他列的激活态切回来也走同一轮换", () => {
    expect(nextSortState({ key: "mtime", dir: "asc" }, "size")).toEqual({ key: "size", dir: "desc" });
  });
});

describe("filterEntries", () => {
  const entries = [file("config.yml"), file("nginx.conf"), file("docs", { isDir: true }), file("README.md")];

  it("空与纯空白 = 不过滤", () => {
    expect(filterEntries(entries, "")).toHaveLength(4);
    expect(filterEntries(entries, "   ")).toHaveLength(4);
  });

  it("子串匹配，大小写不敏感", () => {
    expect(names(filterEntries(entries, "con"))).toEqual(["config.yml", "nginx.conf"]);
    expect(names(filterEntries(entries, "CON"))).toEqual(["config.yml", "nginx.conf"]);
    expect(names(filterEntries(entries, "Config"))).toEqual(["config.yml"]);
  });

  it("目录名命中也会显示", () => {
    expect(names(filterEntries(entries, "doc"))).toEqual(["docs"]);
  });

  it("用户输入按字面匹配，不当正则（`.` `*` 都是普通字符）", () => {
    // 若误用正则，"." 会匹配一切、返回全部 4 条；字面匹配只命中名字里真有点的 3 条。
    expect(filterEntries(entries, ".")).toHaveLength(3);
    expect(filterEntries(entries, "*")).toHaveLength(0);
    expect(filterEntries(entries, "[")).toHaveLength(0);
  });

  it("首尾空白先trim再匹配", () => {
    expect(names(filterEntries(entries, "  con  "))).toEqual(["config.yml", "nginx.conf"]);
  });
});
