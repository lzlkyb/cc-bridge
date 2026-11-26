// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipboardImagePaste } from "./useClipboardImagePaste";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), send: vi.fn(), toast: vi.fn(), readImage: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/terminalUserInput", () => ({ sendTerminalUserInput: mocks.send }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readImage: mocks.readImage }));

let root: Root, host: HTMLDivElement, api: ReturnType<typeof useClipboardImagePaste>;
function Harness() {
  api = useClipboardImagePaste({ sessionId: "s1", connId: "c1", closed: false });
  return null;
}

const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockReset().mockImplementation(async (name: string) => (name === "temp_file_write" ? "/tmp/x.png" : undefined));
  mocks.send.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  mocks.readImage.mockReset().mockResolvedValue({
    rgba: async () => new Uint8Array([0, 0, 0, 255]),
    size: async () => ({ width: 1, height: 1 }),
    close: async () => undefined,
  });
  // jsdom 没有画布实现：编码这一步用桩替掉，测的是「确认前后各做了什么」。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: () => undefined } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })));
  vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("剪贴板图片：上传前必须确认", () => {
  it("🔴 读图编码后停在确认框：一个字节都没离开本机（不落盘、不上传、不插路径）", async () => {
    await act(async () => {
      await api.pasteImage("/home/u");
    });
    expect(api.pending?.remote).toMatch(/^\/home\/u\/clipboard-\d{8}-\d{9}\.png$/);
    expect(api.pending?.url).toBe("blob:preview");
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(api.busy).toBe(true); // 确认框开着时连按被忽略
  });

  it("点「上传」之后才落盘 + 上传 + 把路径插进输入行，并释放预览", async () => {
    await act(async () => {
      await api.pasteImage("/home/u");
    });
    const remote = api.pending!.remote;
    await act(async () => {
      await api.confirmUpload();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("temp_file_write", expect.objectContaining({ ext: "png" }));
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_sftp_put", expect.objectContaining({ connectionId: "c1", local: "/tmp/x.png", remote }));
    expect(mocks.send).toHaveBeenCalledWith("s1", remote);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(api.pending).toBeNull();
    expect(api.busy).toBe(false);
  });

  it("取消：不上传、不插路径，预览释放且可以再来一次", async () => {
    await act(async () => {
      await api.pasteImage("/home/u");
    });
    act(() => api.cancelUpload());
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(api.busy).toBe(false);
    await act(async () => {
      await api.pasteImage("/home/u");
    });
    expect(api.pending).not.toBeNull();
  });

  it("探不到 cwd 时目标退回远端 home（文件名不带目录前缀）", async () => {
    await act(async () => {
      await api.pasteImage(null);
    });
    expect(api.pending?.remote).toMatch(/^clipboard-\d{8}-\d{9}\.png$/);
  });

  it("剪贴板没有图片：友好提示 + 忙标记复位（不会卡住下一次尝试）", async () => {
    mocks.readImage.mockRejectedValueOnce(new Error("no image found"));
    await act(async () => {
      await api.pasteImage("/home/u");
    });
    expect(mocks.toast).toHaveBeenCalledWith("剪贴板里没有图片", "error");
    expect(api.pending).toBeNull();
    expect(api.busy).toBe(false);
  });
});