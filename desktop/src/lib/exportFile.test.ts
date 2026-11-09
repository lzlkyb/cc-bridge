import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn(), reveal: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mocks.reveal }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));

import { saveTextExport, exportedToast, EXPORT_TOAST_MS } from "./exportFile";

beforeEach(() => { mocks.save.mockReset(); mocks.reveal.mockReset(); mocks.invoke.mockReset(); });

const opts = { title: "t", defaultName: "a.csv", ext: "csv" as const, filterName: "CSV", content: "x" };

it("用户在「另存为」里取消时不写盘、返回 null", async () => {
  mocks.save.mockResolvedValue(null);
  await expect(saveTextExport(opts)).resolves.toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("选了路径就交给后端写，并把后端回报的实际路径原样返回", async () => {
  mocks.save.mockResolvedValue("C:\\Users\\u\\Desktop\\a.csv");
  mocks.invoke.mockResolvedValue("C:\\Users\\u\\Desktop\\a.csv");
  await expect(saveTextExport(opts)).resolves.toBe("C:\\Users\\u\\Desktop\\a.csv");
  expect(mocks.save.mock.calls[0][0]).toMatchObject({ defaultPath: "a.csv", filters: [{ extensions: ["csv"] }] });
  expect(mocks.invoke).toHaveBeenCalledWith("save_export_text", { path: "C:\\Users\\u\\Desktop\\a.csv", content: "x" });
});

it("成功提示里带完整路径，按钮能在文件夹中定位到该文件", async () => {
  const toast = vi.fn();
  mocks.reveal.mockResolvedValue(undefined);
  exportedToast(toast, "已导出到", "D:\\x\\a.csv");
  const [message, variant, action, lifetime] = toast.mock.calls[0];
  expect(message).toBe("已导出到：D:\\x\\a.csv");
  expect(variant).toBe("success");
  expect(lifetime).toBe(EXPORT_TOAST_MS);
  action.onClick();
  expect(mocks.reveal).toHaveBeenCalledWith("D:\\x\\a.csv");
});
