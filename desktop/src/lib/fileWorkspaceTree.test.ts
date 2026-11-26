import { describe, expect, it, vi } from "vitest";
import { compareWorkspaceTrees, scanWorkspaceTree, type WorkspaceEntry } from "./fileWorkspaceTree";

const file = (relative: string, size = 10, mtime = 100): WorkspaceEntry => ({ relative, path: `/root/${relative}`, isDir: false, size, mtime });

describe("file workspace comparison", () => {
  it("compares nested paths and retains the remote version for overwrite validation", () => {
    const result = compareWorkspaceTrees([file("src/a.ts", 12), file("src/new.ts"), file("README.md")], [file("src/a.ts"), file("src/old.ts"), file("README.md")]);
    expect(result.map(({ relative, kind }) => [relative, kind])).toEqual([["src/a.ts", "replace"], ["src/new.ts", "upload"], ["src/old.ts", "remove"]]);
    expect(result[0].previous).toEqual({ size: 10, mtime: 100 });
  });

  it("never proposes changes under symlinks and rejects file/directory collisions", () => {
    const link = { ...file("data"), isSymlink: true, isDir: true };
    expect(compareWorkspaceTrees([link], [file("data/keep.log")])).toEqual([]);
    expect(compareWorkspaceTrees([file("data/new.log")], [link])).toEqual([]);
    expect(() => compareWorkspaceTrees([file("data")], [{ ...file("data"), isDir: true }])).toThrow("同名文件与目录冲突");
  });

  it("walks real subdirectories and stops before exposing an incomplete plan", async () => {
    const list = vi.fn(async (path: string) => path === "/root" ? [
      { ...file("src"), name: "src", isDir: true }, { ...file("link"), name: "link", isSymlink: true, isDir: true },
    ] : [{ ...file("src/a.ts"), name: "a.ts" }]);
    const rows = await scanWorkspaceTree(list, "/root", true);
    expect(rows.map(row => row.relative)).toEqual(["src", "link", "src/a.ts"]);
    expect(list.mock.calls.map(([path]) => path)).toEqual(["/root", "/root/src"]);
    const controller = new AbortController(); controller.abort();
    await expect(scanWorkspaceTree(list, "/root", true, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
