// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { downloadMany, putMany } from "./batchTransfer";
import type { TransferCore } from "./useTransferCore";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), askOverwrite: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke, listen: async () => () => {} }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

/** 假 core：只验证批量编排怎么用它，不验证 core 自己（那是 useTransferCore 的测试）。 */
function fakeCore(overrides: Partial<TransferCore> = {}): TransferCore {
  return {
    transfer: null,
    prompt: null,
    dismissPrompt: vi.fn(),
    begin: vi.fn(() => "tid-1"),
    end: vi.fn(),
    cancel: vi.fn(),
    report: vi.fn(),
    askOverwrite: mocks.askOverwrite,
    ...overrides,
  } as unknown as TransferCore;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.askOverwrite.mockResolvedValue("overwrite");
});

const dir = "C:/dl";
const items = [
  { name: "a.txt", remote: "/r/a.txt", local: `${dir}/a.txt` },
  { name: "b.txt", remote: "/r/b.txt", local: `${dir}/b.txt` },
];

it("批量下载一次 invoke 传全部条目（不再逐个 ssh_sftp_get）", async () => {
  mocks.invoke.mockResolvedValue(2);
  const core = fakeCore();
  const r = await downloadMany(core, { connectionId: "c1", dir, items });
  expect(r).toEqual({ done: 2, total: 2 });
  expect(mocks.invoke).toHaveBeenCalledOnce();
  expect(mocks.invoke).toHaveBeenCalledWith(
    "ssh_sftp_get_many",
    expect.objectContaining({ connectionId: "c1", items, overwrite: false }),
  );
  expect(mocks.invoke.mock.calls.some((c) => c[0] === "ssh_sftp_get")).toBe(false);
  expect(core.begin).toHaveBeenCalledWith("down", expect.stringContaining("2"), undefined, 2);
  expect(core.end).toHaveBeenCalledOnce();
});

it("目标已存在时一次问完覆盖，确认后带 overwrite 整批重跑", async () => {
  mocks.invoke
    .mockRejectedValueOnce("CCB_TARGET_EXISTS: 本机已存在 1 个同名文件：C:/dl/a.txt")
    .mockResolvedValueOnce(2);
  const core = fakeCore();
  const r = await downloadMany(core, { connectionId: "c1", dir, items });
  expect(r).toEqual({ done: 2, total: 2 });
  expect(mocks.askOverwrite).toHaveBeenCalledOnce();
  expect(mocks.askOverwrite.mock.calls[0][0]).toMatchObject({
    kind: "down",
    path: dir,
    names: ["a.txt", "b.txt"],
  });
  // 第二次才带 overwrite
  expect(mocks.invoke.mock.calls[1][1].overwrite).toBe(true);
});

it("用户放弃覆盖时不发起第二次传输", async () => {
  mocks.invoke.mockRejectedValueOnce("CCB_TARGET_EXISTS: exists");
  mocks.askOverwrite.mockResolvedValue("cancel");
  const core = fakeCore();
  const r = await downloadMany(core, { connectionId: "c1", dir, items });
  expect(r).toEqual({ done: 0, total: 2 });
  expect(mocks.invoke).toHaveBeenCalledOnce();
});

it("批量上传：existing 缺省先列一次目标目录，防静默覆盖", async () => {
  mocks.invoke.mockResolvedValueOnce([{ name: "a.txt" }, { name: "keep" }]).mockResolvedValueOnce(1);
  const core = fakeCore();
  const files = [
    { local: "C:/up/a.txt", name: "a.txt" },
    { local: "C:/up/new.txt", name: "new.txt" },
  ];
  const r = await putMany(core, { connectionId: "c1", dir: "/r", files });
  expect(r).toEqual({ done: 1, total: 2 });
  expect(mocks.invoke).toHaveBeenNthCalledWith(1, "ssh_sftp_list", {
    connectionId: "c1",
    path: "/r",
  });
  // 同名一次问完，且给 skip 出口
  expect(mocks.askOverwrite).toHaveBeenCalledOnce();
  expect(mocks.askOverwrite.mock.calls[0][0]).toMatchObject({
    kind: "up",
    path: "/r",
    names: ["a.txt"],
    skippable: true,
  });
  // 覆盖确认后单次 invoke 传全部（含同名项）
  expect(mocks.invoke).toHaveBeenNthCalledWith(
    2,
    "ssh_sftp_put_many",
    expect.objectContaining({
      connectionId: "c1",
      items: [
        { local: "C:/up/a.txt", remote: "/r/a.txt" },
        { local: "C:/up/new.txt", remote: "/r/new.txt" },
      ],
    }),
  );
});

it("批量上传选「跳过同名」时不传被跳过的文件", async () => {
  mocks.askOverwrite.mockResolvedValue("skip");
  mocks.invoke.mockResolvedValueOnce([{ name: "a.txt" }]).mockResolvedValueOnce(1);
  const core = fakeCore();
  const files = [
    { local: "C:/up/a.txt", name: "a.txt" },
    { local: "C:/up/new.txt", name: "new.txt" },
  ];
  const r = await putMany(core, { connectionId: "c1", dir: "/r", files });
  expect(r).toEqual({ done: 1, total: 2 });
  expect(mocks.invoke).toHaveBeenNthCalledWith(
    2,
    "ssh_sftp_put_many",
    expect.objectContaining({
      items: [{ local: "C:/up/new.txt", remote: "/r/new.txt" }],
    }),
  );
});

it("批量上传全部同名且选跳过：明确交代，不静默收场", async () => {
  mocks.askOverwrite.mockResolvedValue("skip");
  mocks.invoke.mockResolvedValueOnce([{ name: "a.txt" }]);
  const core = fakeCore();
  const r = await putMany(core, {
    connectionId: "c1",
    dir: "/r",
    files: [{ local: "C:/up/a.txt", name: "a.txt" }],
  });
  expect(r).toEqual({ done: 0, total: 1 });
  // 一次 ssh_sftp_put_many 都不该发
  expect(mocks.invoke).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("已跳过全部"), "info");
});

it("调用方给了 existing 就不再列目录", async () => {
  mocks.invoke.mockResolvedValue(2);
  const core = fakeCore();
  await putMany(core, {
    connectionId: "c1",
    dir: "/r",
    files: [
      { local: "C:/up/a.txt", name: "a.txt" },
      { local: "C:/up/b.txt", name: "b.txt" },
    ],
    existing: [],
  });
  expect(mocks.invoke.mock.calls.some((c) => c[0] === "ssh_sftp_list")).toBe(false);
  expect(mocks.invoke).toHaveBeenCalledOnce();
});

it("空列表不发任何请求", async () => {
  const core = fakeCore();
  expect(await downloadMany(core, { connectionId: "c1", dir, items: [] })).toEqual({ done: 0, total: 0 });
  expect(await putMany(core, { connectionId: "c1", dir: "/r", files: [] })).toEqual({ done: 0, total: 0 });
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(core.begin).not.toHaveBeenCalled();
});
