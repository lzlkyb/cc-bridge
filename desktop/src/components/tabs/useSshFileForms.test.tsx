// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSshFileForms } from "./useSshFileForms";
import type { SshTransfer } from "./useSshTransfer";

const mocks = vi.hoisted(() => ({ open: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...parts: string[]) => parts.join("/"), downloadDir: async () => "D:/Downloads" }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

it("上传多选保留发起时的远端目录，双栏下载使用本机目录", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const uploadMany = vi.fn().mockResolvedValue({ done: 2, total: 2 });
  const download = vi.fn().mockResolvedValue(true);
  const xfer = { uploadMany, download } as unknown as SshTransfer;
  const root = createRoot(document.createElement("div"));
  let current!: ReturnType<typeof useSshFileForms>;
  function Harness({ path }: { path: string }) {
    current = useSshFileForms({ connectionId: "dev", path, entries: [], xfer, dual: true, localPath: "D:/交付", windows: true });
    return null;
  }
  let select!: (value: string[]) => void;
  mocks.open.mockReturnValue(new Promise<string[]>(resolve => { select = resolve; }));
  const sources = ["D:/one.txt", "D:/two.txt"];
  mocks.invoke.mockResolvedValue(sources.map(path => ({path, name: path.slice(3), isDir: false, exists: true})));
  try {
    await act(async () => root.render(<Harness path="/incoming"/>));
    let pending!: Promise<void>;
    await act(async () => { pending = current.pickUpload(); });
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
    await act(async () => root.render(<Harness path="/logs"/>));
    await act(async () => { select(sources); await pending; });
    expect(uploadMany).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "dev", dir: "/incoming",
      files: [{ local: sources[0], name: "one.txt" }, { local: sources[1], name: "two.txt" }],
    }));
    await act(async () => current.handleDownload("report.txt"));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith({ connectionId: "dev", name: "report.txt", remote: "/logs/report.txt", local: "D:/交付/report.txt" });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
