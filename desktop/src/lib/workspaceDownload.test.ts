import { expect, it, vi } from "vitest";
import { queueWorkspaceDownload, validLocalDownloadName } from "./workspaceDownload";
import { repairSshTransfer, retrySshTransfer, useSshTransferQueue } from "./sshTransferQueue";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke, listen: async () => () => {} }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...parts: string[]) => parts.join("/") }));
vi.mock("react", () => ({ useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot() }));

it("保留空目录，跳过符号链接，仅补传 Windows 不兼容的文件", async () => {
  mocks.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "ssh_sftp_list") {
      return args.path === "/logs" ? [
        { name: "empty", isDir: true },
        { name: "current", isDir: false, isSymlink: true },
        { name: "trace:old.log", isDir: false },
        { name: "app.log", isDir: false },
      ] : [];
    }
    if (cmd === "ssh_prepare_download_folder") return `${args.base}/${args.components.join("/")}`;
    if (cmd !== "ssh_sftp_get") throw Error(`Unexpected command: ${cmd}`);
  });
  await queueWorkspaceDownload("linux", "/logs", "D:/deliveries", "logs", true);
  const partial = useSshTransferQueue()[0];
  expect(partial).toMatchObject({status: "partial", issues: [{path: "trace:old.log", rename: "trace:old.log"}]});
  expect(mocks.invoke).toHaveBeenCalledWith("ssh_prepare_download_folder", {
    base: "D:/deliveries", components: ["logs", "empty"], exclusive: false,
  });
  expect(() => repairSshTransfer(partial.id, "trace:old.log", "../outside")).toThrow();
  repairSshTransfer(partial.id, "trace:old.log", "trace-old.log");
  await vi.waitFor(() => expect(useSshTransferQueue()[0].status).toBe("done"));
  expect(mocks.invoke.mock.calls.filter(c => c[0] === "ssh_sftp_get").map(([,args]) => [args.remote, args.local])).toEqual([
    ["/logs/app.log", "D:/deliveries/logs/app.log"],
    ["/logs/trace:old.log", "D:/deliveries/logs/trace-old.log"],
  ]);
});

it("识别 Windows 的设备名和路径字符，同时保留合法的 Linux 名称", () => {
  for (const name of ["NUL.txt", "COM¹.log", "trailing.", "a:b", "a\\b"]) {
    expect(validLocalDownloadName(name, true)).toBe(false);
  }
  expect(validLocalDownloadName("trace:old.log")).toBe(true);
  expect(validLocalDownloadName("交付报告.txt", true)).toBe(true);
});

it("目录中途断线后复用文件的续传标识，补完后继续尚未开始的文件", async () => {
  const trace: { remote: string; transferId: string }[] = [];
  mocks.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "ssh_sftp_list") return [{name: "first.bin"}, {name: "large.bin"}, {name: "last.bin"}];
    if (cmd === "ssh_prepare_download_folder") return `${args.base}/${args.components.join("/")}`;
    if (cmd === "ssh_sftp_get") {
      trace.push(args);
      if (trace.length === 2) throw Error("连接中断");
    }
  });
  await queueWorkspaceDownload("linux", "/export", "D:/out", "export", true);
  const interrupted = useSshTransferQueue()[0];
  expect(interrupted.status).toBe("partial");
  expect(trace.map(row => row.remote)).toEqual(["/export/first.bin", "/export/large.bin"]);
  retrySshTransfer(interrupted.id);
  await vi.waitFor(() => expect(useSshTransferQueue()[0].status).toBe("done"));
  expect(trace.map(row => row.remote)).toEqual(["/export/first.bin", "/export/large.bin", "/export/large.bin", "/export/last.bin"]);
  expect(trace[1].transferId).toBe(trace[2].transferId);
});
