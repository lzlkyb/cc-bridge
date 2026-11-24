// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSshFileRename } from "./useSshFileRename";
import type { SshFileEntry } from "../../lib/types";

const entry = (name: string, isDir = false): SshFileEntry =>
  ({ name, isDir, isSymlink: false, size: 1, mtime: 0 });

const h = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), done: vi.fn(), changed: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("../ui/toast", () => ({ toast: h.toast }));

const joinRemote = (dir: string, name: string) =>
  dir === "/" ? "/" + name : dir.replace(/\/$/, "") + "/" + name;

let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useSshFileRename>;
const currentPath = "/a";function Probe({ path = currentPath }: { path?: string }) {
  api = useSshFileRename({ connectionId: "one", path, joinRemote, onDone: h.done, onChanged: h.changed });
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

it("重命名成功：overwrite=false、成功后收摊并通知调用方", async () => {
  h.invoke.mockResolvedValueOnce(undefined);
  await act(async () => api.openRename(entry("old.txt")));
  await act(async () => api.setRenameName("new.txt"));
  await act(async () => api.submitRename());
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("ssh_sftp_rename", {
    connectionId: "one", path: "/a/old.txt", new_name: "new.txt", overwrite: false,
  });
  expect(h.toast).toHaveBeenCalledWith("已重命名：old.txt → new.txt", "success");
  expect(api.renameEntry).toBeNull();
  expect(h.changed).toHaveBeenCalledOnce();   // 旧名字不会自己从 selected 里掉
  expect(h.done).toHaveBeenCalledOnce();
});

it("🔴 TARGET_EXISTS 转成覆盖确认，点「覆盖」才带 overwrite=true 重放（没有静默覆盖路径）", async () => {
  h.invoke.mockRejectedValueOnce("TARGET_EXISTS");
  await act(async () => api.openRename(entry("old.txt")));
  await act(async () => api.setRenameName("new.txt"));
  await act(async () => api.submitRename());
  expect(api.overwrite?.names).toEqual(["new.txt"]);
  expect(api.overwrite?.paths).toEqual(["/a/new.txt"]);   // 单条给路径框
  h.invoke.mockResolvedValueOnce(undefined);
  await act(async () => api.confirmOverwrite());
  expect(h.invoke).toHaveBeenLastCalledWith("ssh_sftp_rename", {
    connectionId: "one", path: "/a/old.txt", new_name: "new.txt", overwrite: true,
  });
  expect(api.overwrite).toBeNull();
  expect(api.renameEntry).toBeNull();
});

it("普通失败只 toast，不弹覆盖框", async () => {
  h.invoke.mockRejectedValueOnce("permission denied");
  await act(async () => api.openRename(entry("old.txt")));
  await act(async () => api.submitRename());
  expect(h.toast).toHaveBeenCalledWith("重命名失败：permission denied", "error");
  expect(api.overwrite).toBeNull();
  expect(api.renameEntry).not.toBeNull();   // 对话框留着，用户改个名再试
});

it("单条移动成功：目标目录由用户填，后端只收 to_dir", async () => {
  h.invoke.mockResolvedValueOnce(undefined);
  await act(async () => api.openMove([entry("a.txt")]));
  expect(api.moveDir).toBe("/a");            // 默认当前目录
  await act(async () => api.setMoveDir("/dest"));
  await act(async () => api.submitMove());
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("ssh_sftp_move", {
    connectionId: "one", from: "/a/a.txt", to_dir: "/dest", overwrite: false,
  });
  expect(api.moveEntries).toBeNull();
  expect(h.done).toHaveBeenCalledOnce();
});

it("🔴 批量移动先列目标目录：无冲突直接逐条移，串行不并发", async () => {
  h.invoke.mockResolvedValueOnce([]);        // ssh_sftp_list：目标目录空的
  h.invoke.mockResolvedValue(undefined);     // 之后的 move 全部成功
  await act(async () => api.openMove([entry("a.txt"), entry("b.txt")]));
  await act(async () => api.setMoveDir("/dest"));
  await act(async () => api.submitMove());
  expect(h.invoke).toHaveBeenNthCalledWith(1, "ssh_sftp_list", { connectionId: "one", path: "/dest" });
  expect(h.invoke.mock.calls.filter((c) => c[0] === "ssh_sftp_move").map((c) => c[1].from))
    .toEqual(["/a/a.txt", "/a/b.txt"]);
  expect(h.toast).toHaveBeenCalledWith("已移动 2 个条目", "success");
  expect(api.overwrite).toBeNull();          // 没冲突不弹窗
});

it("🔴 批量有冲突：先汇总成一个确认（不逐个弹、不先移一半再问），覆盖 = 先冲突后其余", async () => {
  h.invoke.mockResolvedValueOnce([entry("b.txt")]);   // 目标目录已有 b.txt
  await act(async () => api.openMove([entry("a.txt"), entry("b.txt")]));
  await act(async () => api.setMoveDir("/dest"));
  await act(async () => api.submitMove());
  expect(api.overwrite?.names).toEqual(["b.txt"]);    // 只列冲突的
  expect(h.invoke.mock.calls.filter((c) => c[0] === "ssh_sftp_move")).toHaveLength(0);  // 一个都没移
  h.invoke.mockResolvedValue(undefined);
  await act(async () => api.confirmOverwrite());
  const moves = h.invoke.mock.calls.filter((c) => c[0] === "ssh_sftp_move");
  expect(moves.map((c) => c[1])).toEqual([
    { connectionId: "one", from: "/a/b.txt", to_dir: "/dest", overwrite: true },
    { connectionId: "one", from: "/a/a.txt", to_dir: "/dest", overwrite: false },
  ]);
  expect(api.overwrite).toBeNull();
});

it("批量「跳过这些」只移没冲突的那些", async () => {
  h.invoke.mockResolvedValueOnce([entry("b.txt")]);
  await act(async () => api.openMove([entry("a.txt"), entry("b.txt")]));
  await act(async () => api.setMoveDir("/dest"));
  await act(async () => api.submitMove());
  h.invoke.mockResolvedValue(undefined);
  await act(async () => api.skipConflicts());
  const moves = h.invoke.mock.calls.filter((c) => c[0] === "ssh_sftp_move");
  expect(moves.map((c) => c[1].from)).toEqual(["/a/a.txt"]);
  expect(moves[0][1].overwrite).toBe(false);
  expect(h.toast).toHaveBeenCalledWith("已跳过同名目标，其余已移动", "success");
});

it("批量列目标目录失败：整体报废，一个都不移（比移一半再报错好收拾）", async () => {
  h.invoke.mockRejectedValueOnce("no such directory");
  await act(async () => api.openMove([entry("a.txt"), entry("b.txt")]));
  await act(async () => api.setMoveDir("/dest"));
  await act(async () => api.submitMove());
  expect(h.invoke.mock.calls.filter((c) => c[0] === "ssh_sftp_move")).toHaveLength(0);
  expect(h.toast).toHaveBeenCalledWith("移动失败：no such directory", "error");
  expect(api.moveEntries).not.toBeNull();   // 对话框留着，改个目录再试
});

it("批量里单条失败只 toast 不中断，其余照移", async () => {
  h.invoke.mockResolvedValueOnce([]);                        // list
  h.invoke.mockRejectedValueOnce("cross-device"); // 第一条失败
  h.invoke.mockResolvedValueOnce(undefined);                 // 第二条成功
  await act(async () => api.openMove([entry("a.txt"), entry("b.txt")]));
  await act(async () => api.setMoveDir("/dest"));
  await act(async () => api.submitMove());
  expect(h.invoke.mock.calls.filter((c) => c[0] === "ssh_sftp_move").map((c) => c[1].from))
    .toEqual(["/a/a.txt", "/a/b.txt"]);
  expect(h.toast).toHaveBeenCalledWith("移动 a.txt 失败：cross-device", "error");
  expect(h.toast).not.toHaveBeenCalledWith("已移动 2 个条目", "success");
  expect(h.done).toHaveBeenCalledOnce();   // 失败也刷新：成功的那些要体现出来
});
