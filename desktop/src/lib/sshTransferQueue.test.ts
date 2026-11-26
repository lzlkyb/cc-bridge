import { expect, it, vi } from "vitest";
import { cancelQueuedSshTransfer, queueSshTransfer, retrySshTransfer } from "./sshTransferQueue";
import { uploadWorkspaceFolder } from "./fileWorkspaceActions";
import { invoke } from "./tauri";

vi.mock("./tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
const job = (id: string) => ({ id, connectionId: "server", label: id, target: "/srv/file", direction: "up" as const, resumable: true });

it("serializes transfers, cancels a waiting job, and retries a failure with the original task", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = vi.fn(() => gate);
  const cancelled = vi.fn();
  const third = vi.fn().mockRejectedValueOnce(Error("connection lost")).mockResolvedValueOnce(undefined);
  const active = queueSshTransfer(job("first"), first);
  const queued = queueSshTransfer(job("cancel"), cancelled);
  const rejection = expect(queued).rejects.toThrow("CCB_CANCELLED");
  const next = queueSshTransfer(job("third"), third);
  const failed = expect(next).rejects.toThrow("connection lost");
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
  expect(third).not.toHaveBeenCalled();
  await cancelQueuedSshTransfer("cancel");
  await rejection;
  release();
  await active;
  await failed;
  expect(cancelled).not.toHaveBeenCalled();
  retrySshTransfer("third");
  await vi.waitFor(() => expect(third).toHaveBeenCalledTimes(2));
});

it("removes an interrupted folder staging directory without publishing it", async () => {
  let release!: () => void;
  const mkdir = new Promise<void>(resolve => { release = resolve; });
  const ipc = vi.mocked(invoke);
  ipc.mockClear();
  ipc.mockImplementation(async command => command === "ssh_sftp_list" ? [] : command === "ssh_sftp_mkdir" ? mkdir : undefined);
  const ids = vi.spyOn(crypto, "randomUUID");
  const work = uploadWorkspaceFolder("server", "/srv/folder", "folder", []);
  const rejected = expect(work).rejects.toThrow("CCB_CANCELLED");
  await vi.waitFor(() => expect(ipc).toHaveBeenCalledWith("ssh_sftp_mkdir", expect.objectContaining({ path: expect.stringContaining(".part") })));
  await cancelQueuedSshTransfer(ids.mock.results[0].value);
  release();
  await rejected;
  expect(ipc).toHaveBeenCalledWith("ssh_sftp_remove", expect.objectContaining({ path: expect.stringContaining(".part") }));
  expect(ipc.mock.calls.some(([name]) => name === "ssh_sftp_rename")).toBe(false);
  ids.mockRestore();
});

it("publishes an uploaded folder with the native command's camel-case arguments", async () => {
  const ipc = vi.mocked(invoke);
  ipc.mockClear();
  ipc.mockImplementation(async command => command === "ssh_sftp_list" ? [] : undefined);
  await uploadWorkspaceFolder("server", "/srv/new", "new", []);
  expect(ipc).toHaveBeenCalledWith("ssh_sftp_rename", { connectionId: "server", path: expect.stringContaining(".part"), newName: "new", overwrite: false });
});

it("leaves an overwrite prompt to its caller instead of exposing a broken retry", async () => {
  const run = vi.fn().mockRejectedValue(Error("CCB_TARGET_EXISTS: 目标已存在"));
  await expect(queueSshTransfer({ ...job("conflict"), confirmConflict: true }, run)).rejects.toThrow("CCB_TARGET_EXISTS");
  retrySshTransfer("conflict");
  expect(run).toHaveBeenCalledOnce();
});
