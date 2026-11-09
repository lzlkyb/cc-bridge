// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SshConnectionDialog } from "./SshConnectionDialog";
import { emptySshConnection } from "../../lib/sshConnectionForm";
import { invoke } from "../../lib/tauri";
import { open as pickFile } from "@tauri-apps/plugin-dialog";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "C:/keys/id_ed25519") }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const saved = { ...emptySshConnection(), id: "saved-id", name: "开发", host: "dev.example.com", username: "developer" };
const onClose = vi.fn(), onSaved = vi.fn(), onConnect = vi.fn();
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
const field = (label: string) => [...document.querySelectorAll<HTMLInputElement>("input")].find(i => [...i.labels ?? []].some(l => l.textContent === label))!;
async function fill(label: string, value: string) {
  await act(async () => { const input = field(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function render(initial: typeof saved | null = saved, open = true) { await act(async () => root.render(<SshConnectionDialog open={open} initial={initial} connections={[]} onClose={onClose} onSaved={onSaved} onConnect={onConnect}/>)); }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(invoke).mockResolvedValue(saved); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { button("取消")?.click(); root.unmount(); }); host.remove(); });

it("保存并连接使用后端返回的 ID，一次性密码不随连接配置保存", async () => {
  await render(); await fill("密码", "one-time-only");
  await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(invoke).toHaveBeenCalledWith("ssh_save_connection", { args: { connection: saved, password: null, passphrase: null } });
  expect(onConnect).toHaveBeenCalledWith(saved, { password: "one-time-only" });
  expect(onSaved).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});
it("只保存不会连接，空字段和非法端口有内联错误且不调用后端", async () => {
  await render(null); await fill("端口", "65536");
  await act(async () => button("保存").click());
  expect(document.querySelectorAll('[aria-invalid="true"]').length).toBe(4); expect(invoke).not.toHaveBeenCalled();
  await render(saved); await act(async () => button("保存").click()); expect(onConnect).not.toHaveBeenCalled();
});
it("关闭并重新打开恢复草稿，明确取消后清除草稿", async () => {
  await render(null); await fill("名称", "未完成草稿"); await fill("密码", "temporary");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭 SSH 连接设置"]')!.click());
  await render(null, false); await render(null, true);
  expect(field("名称").value).toBe("未完成草稿"); expect(field("密码").value).toBe("temporary");
  await act(async () => button("取消").click()); await render(null, false); await render(null, true);
  expect(field("名称").value).toBe(""); expect(field("密码").value).toBe("");
});
it("保存失败保留表单和密码，并且不会触发连接", async () => {
  vi.mocked(invoke).mockRejectedValue("磁盘写入失败"); await render(); await fill("密码", "retry-secret");
  await act(async () => button("保存并连接").click());
  expect(document.body.textContent).toContain("保存失败：磁盘写入失败"); expect(field("密码").value).toBe("retry-secret");
  expect(onConnect).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});
it("私钥使用原生选择器，且一次性密码短语只传给本次连接", async () => {
  vi.mocked(pickFile).mockResolvedValue("C:/keys/id_ed25519");
  const keyConnection = { ...saved, authType: "key", keyPath: "" };
  const savedKey = { ...keyConnection, keyPath: "C:/keys/id_ed25519" };
  vi.mocked(invoke).mockResolvedValue(savedKey);
  await render(keyConnection);
  await act(async () => button("选择文件").click());
  expect(field("私钥路径").value).toBe("C:/keys/id_ed25519");
  await fill("密钥密码短语", "once-pp");
  await act(async () => button("保存并连接").click());
  expect(onConnect).toHaveBeenCalledWith(savedKey, { passphrase: "once-pp" });
  expect(invoke).toHaveBeenCalledWith("ssh_save_connection", { args: { connection: savedKey, password: null, passphrase: null } });
});
it("同帧连点保存只发起一次请求，保存中不能关闭", async () => {
  let finish!: (value: typeof saved) => void;
  vi.mocked(invoke).mockReturnValue(new Promise(resolve => { finish = resolve; })); await render();
  await act(async () => { button("保存").click(); button("保存").click(); document.querySelector<HTMLButtonElement>('[aria-label="关闭 SSH 连接设置"]')!.click(); });
  expect(invoke).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
  await act(async () => { finish(saved); }); expect(onSaved).toHaveBeenCalledOnce();
});
