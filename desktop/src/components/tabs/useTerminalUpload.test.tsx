// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalUpload } from "./useTerminalUpload";
import type { SshConnection } from "../../lib/types";

const mocks = vi.hoisted(() => ({ uploadMany: vi.fn(), pick: vi.fn() }));
vi.mock("./useSshTransfer", () => ({
  useSshTransfer: () => ({
    transfer: null,
    prompt: null,
    uploadMany: mocks.uploadMany,
    cancel: vi.fn(),
    dismissPrompt: vi.fn(),
  }),
}));
vi.mock("../../lib/localFiles", () => ({ pickUploadableFiles: mocks.pick }));

const conn = { id: "c1", name: "dev", host: "h" } as SshConnection;
const files = [{ path: "C:/tmp/a.txt", name: "a.txt", size: 3 }];
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useTerminalUpload>;
function Harness({ cwd }: { cwd: string | null }) {
  api = useTerminalUpload(conn, cwd);
  return null;
}
const mount = (cwd: string | null) => act(() => root.render(<Harness cwd={cwd} />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  mocks.pick.mockReset().mockResolvedValue(files);
  mocks.uploadMany.mockReset().mockResolvedValue({ done: 1, failed: 0 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("终端拖放：松手不直传", () => {
  it("🔴 探到 cwd 也只进确认框：预填当前目录，一个字节都没传", async () => {
    await mount("/home/u");
    await act(async () => {
      await api.dropped(["C:/tmp/a.txt"]);
    });
    expect(api.pending).toEqual(files);
    expect(api.dir).toBe("/home/u");
    expect(api.dirFromCwd).toBe(true);
    expect(mocks.uploadMany).not.toHaveBeenCalled();
    expect(api.busy).toBe(true); // 确认框开着时挡第二批拖放
  });

  it("确认之后才上传到该目录，并挂出结果条", async () => {
    await mount("/home/u");
    await act(async () => {
      await api.dropped(["C:/tmp/a.txt"]);
    });
    await act(async () => {
      await api.confirm("/home/u");
    });
    expect(mocks.uploadMany).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c1", dir: "/home/u", files: [{ local: "C:/tmp/a.txt", name: "a.txt" }] }),
    );
    expect(api.pending).toBeNull();
    expect(api.result?.count).toBe(1);
  });

  it("取消：不上传，队列清空，可以重新拖", async () => {
    await mount("/home/u");
    await act(async () => {
      await api.dropped(["C:/tmp/a.txt"]);
    });
    act(() => api.cancelSheet());
    expect(mocks.uploadMany).not.toHaveBeenCalled();
    expect(api.pending).toBeNull();
    expect(api.busy).toBe(false);
  });

  it("探不到 cwd：预填上次用过的目录，文案走「无法探知」那一支", async () => {
    localStorage.setItem("cc-bridge.upload-dir.c1", "/opt");
    await mount(null);
    await act(async () => {
      await api.dropped(["C:/tmp/a.txt"]);
    });
    expect(api.dir).toBe("/opt");
    expect(api.dirFromCwd).toBe(false);
    expect(mocks.uploadMany).not.toHaveBeenCalled();
  });

  it("cwd 带尾斜杠也预填成合法目录（否则确认框被目录校验卡住）", async () => {
    await mount("/home/u/");
    await act(async () => {
      await api.dropped(["C:/tmp/a.txt"]);
    });
    expect(api.dir).toBe("/home/u");
    expect(api.dirFromCwd).toBe(true);
  });

  it("改目录重传：回到确认框而不是再传一次", async () => {
    await mount("/home/u");
    await act(async () => {
      await api.dropped(["C:/tmp/a.txt"]);
    });
    await act(async () => {
      await api.confirm("/home/u");
    });
    act(() => api.changeDir());
    expect(api.pending).toEqual(files);
    expect(api.dir).toBe("/home/u");
    expect(api.dirFromCwd).toBe(false);
    expect(api.result).toBeNull();
    expect(mocks.uploadMany).toHaveBeenCalledTimes(1);
  });
});