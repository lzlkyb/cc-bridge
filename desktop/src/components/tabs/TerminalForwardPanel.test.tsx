// @vitest-environment jsdom
import { h, fixture, legacy, extra, surface, button, mount, click, input, emit, live, manual } from "./terminalForwardTestUtils";
import { act } from "react";
import { expect, it } from "vitest";
import { offerForward } from "../../lib/sshTunnelStore";

it("纯旧转发显示简洁自动管理状态，隐藏重复编辑及开启入口", async () => {
  await mount();
  expect(surface().textContent).toContain("Claude Code 隧道");
  expect(surface().textContent).toContain("自动管理");
  expect(surface().textContent).toContain("已连通");
  expect(surface().querySelectorAll(".fp-rule")).toHaveLength(0);
  expect(button("新增转发").disabled).toBe(false);
  expect(surface().textContent).not.toContain("原有相同规则已由接入卡管理");
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
it("额外手动规则可以开启，托管规则不进入结果列表", async () => {
  fixture.connection.forwards = [legacy, extra];
  await mount();
  expect(surface().querySelectorAll(".fp-rule")).toHaveLength(1);
  await click("开启转发", surface().querySelector("header")!);
  expect(h.invoke).toHaveBeenCalledWith("ssh_tunnel_start", { connectionId: fixture.connection.id, password: null, passphrase: null });
  expect(button("复制使用地址").disabled).toBe(true);
  expect(h.invoke).not.toHaveBeenCalledWith("stable_connect_start", expect.anything());
});
it("暂停与重连事件更新托管状态，均不启动手动转发", async () => {
  await mount();
  fixture.context.managed[0] = { ...fixture.context.managed[0], phase: "stopped", enabled: false };
  await emit("stable_connect_changed"); expect(surface().textContent).toContain("已暂停");
  fixture.context.managed[0] = { ...fixture.context.managed[0], phase: "reconnecting", enabled: true };
  await emit("stable_connect_changed"); expect(surface().textContent).toContain("重连中");
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
it("查看接入不切换，显式切换后才定位到对应接入卡", async () => {
  fixture.context.managed[0].connectionId = "owner";
  await mount(); await click("查看接入");
  expect(h.invoke).not.toHaveBeenCalledWith("stable_connect_select", expect.anything());
  expect(h.navigate).not.toHaveBeenCalled();
  await click("切换为当前接入");
  expect(h.invoke).toHaveBeenCalledWith("stable_connect_select", { method: "stable", connectionId: "owner" });
  expect(h.navigate).toHaveBeenCalledWith("connect", "connect-guide");
});

it("关联读取失败时仍能停止实时状态里已知的手动转发", async () => {
  manual(); await mount(); await emit("ssh_tunnel_status", live());
  fixture.readFails = true;
  await emit("stable_connect_changed");
  expect(surface().textContent).toContain("暂时无法读取转发关联状态");
  expect(button("停止转发").disabled).toBe(false);
  await click("停止转发");
  expect(h.invoke).toHaveBeenCalledWith("ssh_tunnel_stop", { connectionId: fixture.connection.id });
});
it("冲突从结果卡打开编辑，保存新端口后解除开启阻止", async () => {
  const conflict = { ...legacy, id: "conflict", targetPort: 9000 };
  fixture.connection.forwards = [legacy, conflict];
  await mount(); expect(surface().textContent).toContain("端口冲突");
  expect(button("开启转发", surface().querySelector("header")!).disabled).toBe(true);
  await click("编辑规则");
  await input("#fp-access-port", "9001");
  expect(surface().querySelector("#fp-access-port")!.getAttribute("aria-invalid")).toBe("false");
  await click("仅保存配置");
  expect(surface().textContent).not.toContain("端口冲突");
  expect(button("开启转发", surface().querySelector("header")!).disabled).toBe(false);
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
it("没有托管隧道时保留原有手动转发能力", async () => {
  manual([legacy]); await mount();
  expect(surface().textContent).not.toContain("自动管理");
  expect(surface().querySelectorAll(".fp-rule")).toHaveLength(1);
  expect(button("开启转发").disabled).toBe(false);
});
it("关联读取失败时禁止新增和启停，重新读取后恢复", async () => {
  fixture.readFails = true; await mount();
  expect(surface().textContent).toContain("暂时无法读取转发关联状态");
  expect(button("新增转发").disabled).toBe(true);
  fixture.readFails = false; await click("重新读取");
  expect(surface().textContent).toContain("自动管理");
});
it("连接 SSH 只有已托管旧规则时不出现询问弹窗", async () => {
  await mount(true); await act(async () => offerForward(fixture.connection));
  expect(surface().querySelector('[role="dialog"]')).toBeNull();
});
it("混合规则只询问额外数量，选择仅连接终端不会开启转发", async () => {
  fixture.connection.forwards = [legacy, extra];
  await mount(true); await act(async () => offerForward(fixture.connection));
  expect(surface().textContent).toContain("另有 1 条手动端口转发");
  await click("仅连接终端"); expect(surface().querySelector('[role="dialog"]')).toBeNull();
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
it("记住询问选择保留最新服务器字段和所有规则", async () => {
  fixture.connection.forwards = [legacy, extra];
  await mount(true); await act(async () => offerForward(fixture.connection));
  fixture.connection = { ...fixture.connection, name: "新名称", forwards: [legacy, { ...extra, note: "更新备注" }] };
  const expected = { ...fixture.connection, forwardAuto: "off" };
  await act(async () => surface().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("仅连接终端");
  expect(h.invoke).toHaveBeenCalledWith("ssh_save_connection", { args: { connection: expected, password: null, passphrase: null } });
  expect(h.invoke).not.toHaveBeenCalledWith("stable_connect_stop", expect.anything());
});
it("询问期间完成隧道接入会收起旧弹窗", async () => {
  manual([legacy]);
  await mount(true); await act(async () => offerForward(fixture.connection));
  expect(surface().querySelector('[role="dialog"]')).toBeTruthy();
  fixture.context.managed = [{ connectionId: fixture.connection.id, rule: legacy, phase: "ready", enabled: true, message: null }];
  await emit("stable_connect_changed");
  expect(surface().querySelector('[role="dialog"]')).toBeNull();
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
