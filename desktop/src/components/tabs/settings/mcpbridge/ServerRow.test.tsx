// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { ServerRow } from "./ServerRow";
import { ToolFilterEditor } from "./ToolFilterEditor";
import type { McpBridgeServer } from "./types";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const save = vi.fn();
const tools = [{ name: "read_file", summary: "读取文件内容" }, { name: "write_file", summary: "写入文件内容" }];
const server: McpBridgeServer = { name: "files", transport: "stdio", command: "node", args: ["D:/my tools/server.js"], envKeys: ["API_KEY"], cwd: null, enabled: false, state: "ready", toolCount: 2, allowRemoteCwd: false, allowedTools: [], liveCwds: [], tools };
beforeEach(() => { save.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function editor(allowed: string[], list = tools) {
  await act(async () => root.render(<ToolFilterEditor tools={list} allowed={allowed} disabled={false} busy={false} onSave={save} />));
}
describe("工具范围与服务行", () => {
  it("从全部开放取消一项会收窄清单，最后一项不能误清空为全部开放", async () => {
    await editor([]);
    await act(async () => (host.querySelector("input") as HTMLInputElement).click());
    expect(save).toHaveBeenCalledWith(["write_file"]);
    save.mockReset(); await editor(["read_file"]);
    const checkbox = host.querySelector("input") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(save).not.toHaveBeenCalled();
    expect(host.textContent).toContain("如需关闭全部工具，请停用该服务");
  });
  it("单工具的全部开放和最后一个陈旧项也不能被隐式转换为全部开放", async () => {
    await editor([], [tools[0]]);
    expect((host.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    await editor(["old_name"]);
    const remove = host.querySelector('[aria-label="移除陈旧工具 old_name"]') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    const restore = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("恢复全部暴露"))!;
    await act(async () => restore.click());
    expect(save).toHaveBeenCalledWith([]);
  });
  it("停用不显示为就绪，详情提供展开语义且图标操作具有名称", async () => {
    const noop = () => {};
    await act(async () => root.render(<ServerRow server={server} master busy={false} onToggle={noop} onProbe={noop} onEdit={noop} onRemove={noop} onToggleRemoteCwd={noop} onSetAllowedTools={save} />));
    expect(host.textContent).toContain("已停用");
    expect(host.textContent).not.toContain("已就绪");
    expect(host.querySelector('[aria-label="编辑 files 启动参数"]')).not.toBe(null);
    const details = host.querySelector('[aria-expanded]') as HTMLButtonElement;
    expect(details.getAttribute("aria-expanded")).toBe("false");
    await act(async () => details.click());
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(details.getAttribute("aria-controls")!)).not.toBe(null);
    expect(host.textContent).toContain('node "D:/my tools/server.js"');
    expect(host.textContent).toContain("读取文件内容");
  });
});
