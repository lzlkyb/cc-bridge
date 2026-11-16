// @vitest-environment jsdom
import { h, fixture, extra, surface, mount, click, settle, live } from "./terminalForwardTestUtils";
import { act } from "react";
import { expect, it } from "vitest";

async function selectAuto(index: number) { await act(async () => surface().querySelectorAll<HTMLInputElement>('.fp-auto-options input[type="radio"]')[index].click()); await settle(); }
it("启动方式使用明显设置栏，选择后立即保存但不启停隧道", async () => {
  fixture.connection.forwards!.push(extra); live(); await mount(); await click("更改启动方式");
  expect(surface().querySelectorAll('.fp-auto-options input[type="radio"]')).toHaveLength(4);
  await selectAuto(2);
  expect(fixture.connection.forwardAuto).toBe("connect");
  expect(surface().querySelector(".fp-auto-current strong")!.textContent).toBe("连接终端时开启");
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_stop", expect.anything());
  expect(h.invoke).not.toHaveBeenCalledWith("stable_connect_start", expect.anything());
});
it("启动方式保存失败保留原选择，已暂停的隧道保持暂停", async () => {
  fixture.context.managed[0].enabled = false; fixture.context.managed[0].phase = "stopped";
  fixture.saveFails = true; await mount(); await click("更改启动方式"); await selectAuto(3);
  expect(surface().querySelector(".fp-auto-current strong")!.textContent).toBe("连接终端时询问");
  expect(surface().querySelectorAll<HTMLInputElement>('.fp-auto-options input[type="radio"]')[1].checked).toBe(true);
  expect(surface().textContent).toContain("已暂停");
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});
it("启动方式保存期间禁用其他操作，新增按钮不显示建立转发的加载文字", async () => {
  const execute = h.invoke.getMockImplementation()!;
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  h.invoke.mockImplementation(async (command: string, args?: unknown) => { if (command === "ssh_save_connection") await wait; return execute(command, args); });
  await mount(); await click("更改启动方式");
  await act(async () => surface().querySelectorAll<HTMLInputElement>('.fp-auto-options input[type="radio"]')[0].click());
  const primary = surface().querySelector<HTMLButtonElement>(".fp-page-actions button")!;
  expect(primary.disabled).toBe(true); expect(primary.getAttribute("aria-busy")).toBeNull();
  expect(primary.textContent).toContain("新增转发");
  await act(async () => release()); await settle();
});
