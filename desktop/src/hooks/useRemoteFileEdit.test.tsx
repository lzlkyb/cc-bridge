// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoteFileEdit } from "./useRemoteFileEdit";

const h = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("../components/ui/toast", () => ({ toast: h.toast }));

const READ = {
  content: "line1\nline2\n",
  size: 12,
  mtime: 1700000000,
  truncated: false,
  lineEnding: "lf",
  encoding: "utf-8",
};

interface Snap {
  phase: string;
  content: string;
  dirty: boolean;
  readOnly: boolean;
  conflict: boolean;
  error: string | null;
  mtime: number;
  encoding: string;
}

/** 把 hook 的状态快照进一个可变对象，便于断言。 */
function useProbe(
  connectionId: string,
  path: string,
  onExternalOpened?: (info: { localPath: string; mtime: number }) => void,
) {
  const edit = useRemoteFileEdit({ connectionId, path, onExternalOpened });
  (globalThis as unknown as { __snap: Snap }).__snap = {
    phase: edit.phase,
    content: edit.content,
    dirty: edit.dirty,
    readOnly: edit.readOnly,
    conflict: edit.conflict,
    error: edit.error,
    mtime: edit.meta?.mtime ?? 0,
    encoding: edit.meta?.encoding ?? "",
  };
  return edit;
}

let root: Root;
let host: HTMLDivElement;
const snap = () => (globalThis as unknown as { __snap: Snap }).__snap;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("useRemoteFileEdit", () => {
  it("挂载即读取，成功后进入 ready 且未修改", async () => {
    h.invoke.mockResolvedValueOnce(READ);
    await act(async () => {
      root.render(<Probe />);
    });
    expect(h.invoke).toHaveBeenCalledWith("ssh_file_read", {
      connectionId: "c1",
      path: "/a.txt",
    });
    expect(snap().phase).toBe("ready");
    expect(snap().content).toBe("line1\nline2\n");
    expect(snap().dirty).toBe(false);
  });

  it("编辑后 dirty；保存成功后 dirty 清除并刷新 mtime 基线", async () => {
    h.invoke.mockResolvedValueOnce(READ);
    let api!: ReturnType<typeof useRemoteFileEdit>;
    await act(async () => {
      root.render(<Probe onReady={(a) => (api = a)} />);
    });
    await act(async () => api.onChange("changed"));
    expect(snap().dirty).toBe(true);

    h.invoke.mockResolvedValueOnce({ mtime: 1700000999, size: 8 });
    await act(async () => {
      await api.save(false);
    });
    expect(h.invoke).toHaveBeenLastCalledWith("ssh_file_write", {
      connectionId: "c1",
      path: "/a.txt",
      content: "changed",
      lineEnding: "lf",
      encoding: "utf-8",
      expectedMtime: 1700000000,
      force: false,
    });
    expect(snap().dirty).toBe(false);
    expect(snap().mtime).toBe(1700000999);
  });

  it("GBK 文件：读回的 encoding 标签必须原样带回写命令（否则被静默转码成 UTF-8）", async () => {
    h.invoke.mockResolvedValueOnce({ ...READ, encoding: "gbk", content: "公用\n方法\n" });
    let api!: ReturnType<typeof useRemoteFileEdit>;
    await act(async () => {
      root.render(<Probe onReady={(a) => (api = a)} />);
    });
    expect(snap().encoding).toBe("gbk");
    await act(async () => api.onChange("公用\n工具\n"));
    h.invoke.mockResolvedValueOnce({ mtime: 2, size: 8 });
    await act(async () => {
      await api.save(false);
    });
    expect(h.invoke).toHaveBeenLastCalledWith(
      "ssh_file_write",
      expect.objectContaining({ encoding: "gbk", lineEnding: "lf" }),
    );
  });

  it("🔴 远端被改：保存被拒但不丢用户修改，只置 conflict", async () => {
    h.invoke.mockResolvedValueOnce(READ);
    let api!: ReturnType<typeof useRemoteFileEdit>;
    await act(async () => {
      root.render(<Probe onReady={(a) => (api = a)} />);
    });
    await act(async () => api.onChange("mine"));
    h.invoke.mockRejectedValueOnce(
      new Error("CCB_FILE_CONFLICT: 服务器上的文件在你打开之后被改过（远端 mtime 1700000009）"),
    );
    await act(async () => {
      await api.save(false);
    });
    expect(snap().conflict).toBe(true);
    // 关键：用户的修改还在，没被回滚
    expect(snap().content).toBe("mine");
    expect(snap().dirty).toBe(true);
    expect(snap().phase).toBe("ready");
  });

  it("force 保存把 expectedMtime 与 force 一并传下去", async () => {
    h.invoke.mockResolvedValueOnce(READ);
    let api!: ReturnType<typeof useRemoteFileEdit>;
    await act(async () => {
      root.render(<Probe onReady={(a) => (api = a)} />);
    });
    h.invoke.mockResolvedValueOnce({ mtime: 1, size: 1 });
    await act(async () => {
      await api.save(true);
    });
    expect(h.invoke).toHaveBeenLastCalledWith(
      "ssh_file_write",
      expect.objectContaining({ force: true }),
    );
    expect(snap().conflict).toBe(false);
  });

  it("大文件截断 ⇒ 只读，且不发保存", async () => {
    h.invoke.mockResolvedValueOnce({ ...READ, truncated: true, size: 5 * 1024 * 1024 });
    let api!: ReturnType<typeof useRemoteFileEdit>;
    await act(async () => {
      root.render(<Probe onReady={(a) => (api = a)} />);
    });
    expect(snap().readOnly).toBe(true);
    h.invoke.mockClear();
    await act(async () => {
      await api.save(false);
    });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("二进制文件：不进编辑态，error 标记为 binary 让 UI 引导外部打开", async () => {
    h.invoke.mockRejectedValueOnce(new Error("CCB_FILE_BINARY: 文件不是 UTF-8 或 GBK/GB18030 文本，请用本机编辑器打开"));
    await act(async () => {
      root.render(<Probe />);
    });
    expect(snap().error).toBe("binary");
    expect(snap().phase).toBe("ready");
  });

  it("C 路线：用本机编辑器打开后把临时副本信息交给 UI", async () => {
    h.invoke.mockResolvedValueOnce(READ);
    let api!: ReturnType<typeof useRemoteFileEdit>;
    let opened: { localPath: string; mtime: number } | null = null;
    await act(async () => {
      root.render(<Probe onReady={(a) => (api = a)} onOpened={(i) => (opened = i)} />);
    });
    h.invoke.mockResolvedValueOnce({ localPath: "C:\\Temp\\ccb-edit\\c1\\a.txt", mtime: 1700000000 });
    await act(async () => {
      await api.openExternal();
    });
    expect(h.invoke).toHaveBeenLastCalledWith("ssh_file_open_external", {
      connectionId: "c1",
      path: "/a.txt",
    });
    expect(opened).toEqual({ localPath: "C:\\Temp\\ccb-edit\\c1\\a.txt", mtime: 1700000000 });
  });

  it("换文件重新读取（path 变即重新加载）", async () => {
    h.invoke.mockResolvedValueOnce(READ);
    await act(async () => {
      root.render(<Probe path="/a.txt" />);
    });
    h.invoke.mockResolvedValueOnce({ ...READ, content: "other\n", path: "/b.txt" });
    await act(async () => {
      root.render(<Probe path="/b.txt" />);
    });
    expect(h.invoke).toHaveBeenLastCalledWith("ssh_file_read", {
      connectionId: "c1",
      path: "/b.txt",
    });
    expect(snap().content).toBe("other\n");
  });
});

function Probe({
  path = "/a.txt",
  onReady,
  onOpened,
}: {
  path?: string;
  onReady?: (api: ReturnType<typeof useRemoteFileEdit>) => void;
  onOpened?: (info: { localPath: string; mtime: number }) => void;
}) {
  const api = useProbe("c1", path, onOpened);
  onReady?.(api);
  return null;
}
