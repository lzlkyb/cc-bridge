// @vitest-environment jsdom
import { h, fixture, extra, legacy, surface, button, mount, click, input, emit, manual, live } from "./terminalForwardTestUtils";
import { act } from "react";
import { expect, it } from "vitest";

const confirmRestart = () => click("确认并继续", document.body);

it.each(["在本机访问服务器服务", "在服务器访问本机服务"])("%s：填服务端口即可保存并开启，监听成功后复制", async purpose => {
  manual([]); await mount(); await click(purpose);
  await input("#fp-target-port", "3000");
  expect(surface().querySelector<HTMLInputElement>("#fp-access-port")!.value).toBe("3000");
  await click("保存并开启");
  expect(fixture.connection.forwards).toHaveLength(1);
  expect(fixture.connection.forwards![0]).toMatchObject({ kind: purpose.startsWith("在本机") ? "local" : "remote", targetPort: 3000, listenPort: 3000, targetHost: "127.0.0.1", listenHost: "127.0.0.1" });
  expect(button("复制使用地址").disabled).toBe(true);
  await emit("ssh_tunnel_status", live()); await click("复制使用地址");
  expect(h.clipboard).toHaveBeenCalledWith("127.0.0.1:3000");
});
it("仅保存编辑保留旧使用地址，应用后按新监听事件更新", async () => {
  manual(); live(); await mount(); await click("编辑"); await input("#fp-access-port", "15433"); await click("仅保存配置");
  expect(surface().querySelector(".fp-use-address code")!.textContent).toBe("127.0.0.1:15432");
  expect(surface().textContent).toContain("更改尚未应用");
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
  await click("复制使用地址"); expect(h.clipboard).toHaveBeenLastCalledWith("127.0.0.1:15432");
  await click("应用更改", surface().querySelector("header")!);
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("数据库 · 15432");
  await confirmRestart();
  expect(button("复制使用地址").disabled).toBe(true);
  await emit("ssh_tunnel_status", live());
  expect(surface().querySelector(".fp-use-address code")!.textContent).toBe("127.0.0.1:15433");
  expect(surface().textContent).not.toContain("更改尚未应用");
});
it("保存失败保留表单输入，不启动转发、不假装已保存", async () => {
  manual([]); await mount(); await click("在本机访问服务器服务"); await input("#fp-target-port", "3000");
  fixture.saveFails = true; await click("仅保存配置");
  expect(surface().querySelector<HTMLInputElement>("#fp-target-port")!.value).toBe("3000");
  expect(fixture.connection.forwards).toHaveLength(0);
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
  expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("保存转发规则失败"), "error");
});
it("新规则已保存但开启失败时，重试复用同一规则 ID", async () => {
  manual([]); fixture.startFails = true; await mount(); await click("在本机访问服务器服务"); await input("#fp-target-port", "3000"); await click("保存并开启");
  const id = fixture.connection.forwards![0].id;
  expect(surface().querySelector('form[aria-label="编辑转发"]')).toBeTruthy();
  fixture.startFails = false; await click("保存并开启");
  expect(fixture.connection.forwards).toHaveLength(1);
  expect(fixture.connection.forwards![0].id).toBe(id);
});
it("修改一条规则保留最新服务器、凭据密文和其他规则", async () => {
  manual(); await mount(); await click("编辑"); await input("#fp-access-port", "15433");
  const other = { ...extra, id: "recent", listenPort: 16432, note: "另一处新加的规则", enabled: false };
  fixture.connection = { ...fixture.connection, host: "new-server.test", username: "new-user", encryptedPassword: "new-ciphertext", forwards: [extra, other] };
  await click("仅保存配置");
  expect(fixture.connection).toMatchObject({ host: "new-server.test", username: "new-user", encryptedPassword: "new-ciphertext", forwards: [{ ...extra, listenPort: 15433 }, other] });
  expect(h.invoke).toHaveBeenCalledWith("ssh_save_connection", { args: { connection: fixture.connection, password: null, passphrase: null } });
});
it("只修改名称并应用不重启正常运行的转发", async () => {
  manual(); live(); await mount(); await click("编辑"); await input("#fp-rule-name", "新数据库名称"); await click("应用更改");
  expect(surface().textContent).toContain("新数据库名称");
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
it("启用某条规则不顺带启用其他已停用规则", async () => {
  const second = { ...extra, id: "second", listenPort: 16432, enabled: false };
  manual([{ ...extra, enabled: false }, second]); await mount(); await click("启用并开启", surface().querySelector("#forward-rule-database")!);
  expect(fixture.connection.forwards).toEqual([{ ...extra, enabled: true }, second]);
  expect(fixture.context.manualStatus!.rules).toHaveLength(1);
});
it("删除运行规则后应用失败，保留旧运行卡与地址供再次应用", async () => {
  const second = { ...legacy, id: "reverse", listenPort: 8000 };
  manual([extra, second]); live(); await mount(); fixture.startFails = true;
  await act(async () => surface().querySelector<HTMLButtonElement>('#forward-rule-database button[aria-label="删除这条转发"]')!.click());
  await click("删除规则", surface().querySelector("#forward-rule-database")!);
  await confirmRestart();
  expect(fixture.connection.forwards).toEqual([second]);
  expect(surface().querySelector("#forward-rule-database")!.textContent).toContain("删除尚未生效");
  expect(surface().querySelector("#forward-rule-database .fp-use-address code")!.textContent).toBe("127.0.0.1:15432");
  fixture.startFails = false; await click("应用更改", surface().querySelector("header")!); await confirmRestart();
  expect(surface().querySelector("#forward-rule-database")).toBeNull();
});
it("删除最后一条运行规则调用手动停止，保持托管隧道暂停", async () => {
  fixture.connection.forwards = [legacy, extra]; fixture.context.managed[0].enabled = false; fixture.context.managed[0].phase = "stopped";
  live(); await mount();
  await act(async () => surface().querySelector<HTMLButtonElement>('button[aria-label="删除这条转发"]')!.click()); await click("删除规则");
  await confirmRestart();
  expect(h.invoke).toHaveBeenCalledWith("ssh_tunnel_stop", { connectionId: fixture.connection.id });
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
  expect(h.invoke).not.toHaveBeenCalledWith("stable_connect_start", expect.anything());
  expect(surface().textContent).toContain("已暂停");
});
it("停止失败保留真实运行地址和状态", async () => {
  manual(); live(); fixture.stopFails = true; await mount(); await click("停止转发");
  expect(button("复制使用地址").disabled).toBe(false);
  expect(surface().textContent).toContain("入口已监听");
});
it("部分监听失败时标题提示需处理，其他成功规则仍可以复制", async () => {
  const failed = { ...legacy, id: "blocked", listenPort: 8000 };
  manual([extra, failed]); live("up", [{ rule: extra, state: "listening", boundPort: 15432, message: null }, { rule: failed, state: "failed", boundPort: null, message: "端口占用" }]);
  await mount(); expect(surface().querySelector(".fp-page-phase")!.textContent).toContain("需处理");
  expect(button("复制使用地址", surface().querySelector("#forward-rule-database")!).disabled).toBe(false);
  expect(button("复制使用地址", surface().querySelector("#forward-rule-blocked")!).disabled).toBe(true);
});
it("服务器自动分配端口展示实际地址，分配未知时禁止复制", async () => {
  const automatic = { ...legacy, id: "allocated", listenPort: 0 };
  manual([automatic]); live("up", [{ rule: automatic, state: "listening", boundPort: 32123, message: null }]); await mount();
  expect(surface().querySelector(".fp-use-address code")!.textContent).toBe("127.0.0.1:32123");
  await click("复制使用地址"); expect(h.clipboard).toHaveBeenCalledWith("127.0.0.1:32123");
  await emit("ssh_tunnel_status", live("reconnecting", [{ rule: automatic, state: "pending", boundPort: null, message: null }]));
  expect(button("复制使用地址").disabled).toBe(true);
  expect(surface().querySelector(".fp-use-address code")!.textContent).not.toContain(":0");
});
it("切换自动分配后显示待分配提示，改回固定方式保留原输入", async () => {
  manual([]); await mount(); await click("在服务器访问本机服务"); await input("#fp-target-port", "3000"); await input("#fp-access-port", "4000");
  const toggle = () => surface().querySelectorAll<HTMLInputElement>('.fp-extra-options input[type="checkbox"]')[1].click();
  await act(async () => toggle());
  expect(surface().querySelector<HTMLInputElement>("#fp-access-port")!.value).toBe("");
  expect(surface().querySelector<HTMLInputElement>("#fp-access-port")!.disabled).toBe(true);
  await act(async () => toggle()); expect(surface().querySelector<HTMLInputElement>("#fp-access-port")!.value).toBe("4000");
  await act(async () => toggle()); await click("仅保存配置");
  expect(fixture.connection.forwards![0].listenPort).toBe(0);
  expect(button("复制使用地址").disabled).toBe(true);
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
it("非法端口聚焦错误字段，不给出冲突端口建议", async () => {
  manual([]); await mount(); await click("在本机访问服务器服务"); await input("#fp-target-port", "3000"); await input("#fp-access-port", "65536"); await click("保存并开启");
  expect(document.activeElement).toBe(surface().querySelector("#fp-access-port"));
  expect(surface().querySelector(".fp-suggestion")).toBeNull();
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_save_connection", expect.anything());
});
it("同一帧连续点击只保存并开启一次", async () => {
  manual([]); await mount(); await click("在本机访问服务器服务"); await input("#fp-target-port", "3000");
  await act(async () => { const control = button("保存并开启"); control.click(); control.click(); });
  expect(h.invoke.mock.calls.filter(call => call[0] === "ssh_save_connection")).toHaveLength(1);
  expect(h.invoke.mock.calls.filter(call => call[0] === "ssh_tunnel_start")).toHaveLength(1);
  expect(fixture.connection.forwards).toHaveLength(1);
});
it.each(["password", "key"])("%s 的补充登录信息只用于本次开启，停止后清除", async authType => {
  manual(); fixture.connection.authType = authType;
  const needsSecret = { ...live("error"), needsSecret: true }; fixture.context.manualStatus = needsSecret;
  await mount(); await input("#fp-login-secret", "one-time-example"); await click("输入并开启");
  expect(h.invoke).toHaveBeenCalledWith("ssh_tunnel_start", { connectionId: fixture.connection.id, password: authType === "password" ? "one-time-example" : null, passphrase: authType === "key" ? "one-time-example" : null });
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_save_connection", expect.anything());
  await emit("ssh_tunnel_status", live()); await click("停止转发"); await emit("ssh_tunnel_status", { ...live("error"), needsSecret: true });
  expect(surface().querySelector<HTMLInputElement>("#fp-login-secret")!.value).toBe("");
});
