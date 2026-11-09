// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshConnectionDialog } from "./SshConnectionDialog";
import { invoke } from "../../lib/tauri";
import type { SshConnection } from "../../lib/types";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const onClose = vi.fn();
const connection: SshConnection = {
  id: "test", name: "测试连接", host: "192.0.2.10", port: 22, username: "demo",
  authType: "password", rememberPassword: false, encryptedPassword: "", keyPath: "",
  rememberPassphrase: false, encryptedPassphrase: "", proxyJumpId: "",
};
const namedButton = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const field = (label: string) => {
  const input = [...document.querySelectorAll<HTMLInputElement>("input")]
    .find(node => [...(node.labels ?? [])].some(item => item.textContent === label));
  expect(input, `字段「${label}」应有可访问的关联标签`).toBeDefined();
  return input!;
};
const render = (authType = "password") => act(async () => root.render(
  <SshConnectionDialog open initial={{ ...connection, authType }} connections={[]} onClose={onClose} onSaved={() => {}} />,
));
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("基本字段可通过标签定位，跳板机和关闭按钮有明确名称", async () => {
  await render();
  expect(field("名称").value).toBe("测试连接");
  expect(field("主机").value).toBe("192.0.2.10");
  expect(field("端口").value).toBe("22");
  expect(field("用户名").value).toBe("demo");
  expect(namedButton("跳板机：不使用（直连）")).toBeTruthy();
  await act(async () => namedButton("关闭 SSH 连接设置").click());
  expect(onClose).toHaveBeenCalledOnce();
});

it("跳板机常驻可选，切换直连同步更新连接路径", async () => {
  await act(async () => root.render(
    <SshConnectionDialog open initial={{ ...connection, proxyJumpId: "jump" }}
      connections={[{ ...connection, id: "jump", name: "堡垒机" }]} onClose={onClose} onSaved={() => {}} />,
  ));
  expect(namedButton("跳板机：堡垒机")).toBeTruthy();
  expect(document.querySelector(".ssh-connection-route")?.textContent).toContain("堡垒机");
  await act(async () => namedButton("跳板机：堡垒机").click());
  const direct = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b => b.textContent?.includes("不使用（直连）"))!;
  await act(async () => direct.click());
  expect(document.querySelector(".ssh-connection-route")?.textContent).not.toContain("堡垒机");
});

it("密码显隐操作可命名并报告按下状态，保持输入节点和值", async () => {
  await render();
  const password = field("密码");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "test-only");
    password.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(password.type).toBe("password");
  expect(namedButton("显示密码").getAttribute("aria-pressed")).toBe("false");
  await act(async () => namedButton("显示密码").click());
  expect(field("密码")).toBe(password);
  expect(password.type).toBe("text");
  expect(password.value).toBe("test-only");
  expect(namedButton("隐藏密码").getAttribute("aria-pressed")).toBe("true");
  await act(async () => namedButton("隐藏密码").click());
  expect(password.type).toBe("password");
});

it("密钥字段关联正确，认证选择与密码短语显隐状态可访问", async () => {
  await render("key");
  const auth = document.querySelector('[role="group"][aria-label="认证方式"]')!;
  const choices = [...auth.querySelectorAll("button")];
  expect(choices.find(node => node.textContent === "密钥")?.getAttribute("aria-pressed")).toBe("true");
  expect(field("私钥路径")).toBeTruthy();
  const passphrase = field("密钥密码短语");
  expect(passphrase.type).toBe("password");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(passphrase, "pp-only");
    passphrase.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => namedButton("显示密码短语").click());
  expect(field("密钥密码短语").type).toBe("text");
  expect(field("密钥密码短语").value).toBe("pp-only");
  await act(async () => choices.find(node => node.textContent === "密码")!.click());
  expect(field("密码").type).toBe("password");
  expect(choices.find(node => node.textContent === "密码")?.getAttribute("aria-pressed")).toBe("true");
});

// ── 已保存凭据的「点眼睛查看」 ────────────────────────────
// 🔴 回归：编辑态输入框初始为空（库里只有密文，前端没有明文），旧实现只切
// type=text，用户点眼睛什么都看不到 —— 看起来就是「显隐功能坏了」。

const renderSaved = async (authType: "password" | "key" = "password") =>
  act(async () => root.render(
    <SshConnectionDialog open
      initial={{
        ...connection, authType,
        rememberPassword: true, encryptedPassword: "cipher-pw",
        rememberPassphrase: true, encryptedPassphrase: "cipher-pp",
      }}
      connections={[]} onClose={onClose} onSaved={() => {}} />,
  ));

it("编辑态点眼睛时向本机要一次解密，并把明文填进框", async () => {
  vi.mocked(invoke).mockResolvedValue("stored-secret");
  await renderSaved();
  expect(field("密码").value).toBe("");
  expect(field("密码").type).toBe("password");
  await act(async () => namedButton("显示密码").click());
  expect(invoke).toHaveBeenCalledWith("ssh_reveal_credential", { id: "test", field: "password" });
  expect(field("密码").value).toBe("stored-secret");
  expect(field("密码").type).toBe("text");
  // 再点一次只是遮回去，值不能丢，也不再请求后端。
  await act(async () => namedButton("隐藏密码").click());
  expect(field("密码").type).toBe("password");
  expect(field("密码").value).toBe("stored-secret");
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
});

it("密钥认证的密码短语同样能取回已保存的明文", async () => {
  vi.mocked(invoke).mockResolvedValue("stored-pp");
  await renderSaved("key");
  await act(async () => namedButton("显示密码短语").click());
  expect(invoke).toHaveBeenCalledWith("ssh_reveal_credential", { id: "test", field: "passphrase" });
  expect(field("密钥密码短语").value).toBe("stored-pp");
  expect(field("密钥密码短语").type).toBe("text");
});

it("解密失败时保持遮罩，不把空框当成已显示的密码", async () => {
  vi.mocked(invoke).mockRejectedValue("密码解密失败（密钥或密文损坏）");
  await renderSaved();
  await act(async () => namedButton("显示密码").click());
  // 关键：切换没发生，否则用户会以为「密码是空的」。
  expect(field("密码").type).toBe("password");
  expect(field("密码").value).toBe("");
  expect(namedButton("显示密码").getAttribute("aria-pressed")).toBe("false");
});

it("旧解密请求晚到时不会覆盖用户新输入的密码", async () => {
  let finish!: (value: string) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
  await renderSaved();
  await act(async () => namedButton("显示密码").click());
  await act(async () => {
    const password = field("密码");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "new-input");
    password.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { finish("old-stored-secret"); });
  expect(field("密码").value).toBe("new-input");
  expect(field("密码").type).toBe("password");
  expect(namedButton("显示密码").disabled).toBe(false);
});
