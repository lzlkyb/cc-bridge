// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshConnectionDialog } from "./SshConnectionDialog";
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

it("折叠的跳板机控件也能读出已选择的连接", async () => {
  await act(async () => root.render(
    <SshConnectionDialog open initial={{ ...connection, proxyJumpId: "jump" }}
      connections={[{ ...connection, id: "jump", name: "堡垒机" }]} onClose={onClose} onSaved={() => {}} />,
  ));
  expect(namedButton("跳板机：堡垒机")).toBeTruthy();
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
  expect(field("密钥密码短语").type).toBe("password");
  await act(async () => namedButton("显示密码短语").click());
  expect(field("密钥密码短语").type).toBe("text");
  await act(async () => choices.find(node => node.textContent === "密码")!.click());
  expect(field("密码").type).toBe("password");
  expect(choices.find(node => node.textContent === "密码")?.getAttribute("aria-pressed")).toBe("true");
});
