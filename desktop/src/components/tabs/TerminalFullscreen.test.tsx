// @vitest-environment jsdom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalFullscreenProvider } from "./TerminalFullscreenContext";
import { TerminalTabsBar } from "./TerminalTabsBar";
import { SshTerminalToolbar, type SshTerminalToolbarProps } from "./SshTerminalToolbar";
import type { SshConnection, StaticStatus } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";

const h = vi.hoisted(() => ({ invoke: vi.fn(), navigate: vi.fn(), exit: vi.fn(), changed: vi.fn(), search: vi.fn(), paste: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => { throw new Error("browser"); } }));
vi.mock("./TerminalGlobalSearch", () => ({ TerminalGlobalSearch: ({onClose}: {onClose: () => void}) => <div role="dialog" aria-label="搜索全部会话"><button onClick={onClose}>关闭搜索</button></div> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conn = {id:"a", name:"公司claude code", host:"192.0.2.10"} as SshConnection;
const sessions: SshSessionRef[] = [{conn, sessionId:"a", tabId:"tab-a", closedReason:null}];
const noop = () => {};
const toolbar: SshTerminalToolbarProps = {conn, compact:true, fullscreen:true, closed:false, focused:true, inputErr:null, selectMode:false, shiftActive:false, dragSelecting:false, imgBusy:false, onCopy:noop, onCopyScreen:noop, onPaste:h.paste, onPasteImage:noop, onRepaint:noop, onSearch:h.search, onToggleSelectMode:noop, onClear:noop, onToggleFullscreen:h.exit, onExport:noop};
let root: Root, container: HTMLDivElement;
function Harness({fullscreen=true,closed=false,running=true}: {fullscreen?:boolean;closed?:boolean;running?:boolean}) {
  const [host, setHost] = useState<HTMLDivElement|null>(null);
  return <TerminalFullscreenProvider fullscreen={fullscreen} status={{running,whitelistEnabled:true,shellEnabled:true} as StaticStatus} sessions={sessions} onActivate={noop} onNavigate={h.navigate} onChanged={h.changed} onExit={h.exit}>
    <TerminalTabsBar fullscreen={fullscreen} onExitFullscreen={h.exit} sessions={sessions} metaBySession={{a:{title:"很长的远端任务标题"} as never}} activeId="a" onActivate={noop} onDisconnect={noop} onCloseTab={noop} onNewTerminal={noop} onToggleSplit={noop} splitActive={false} onToolbarReady={setHost}/>
    {host && createPortal(<SshTerminalToolbar {...toolbar} closed={closed} fullscreen={fullscreen}/>,host)}
  </TerminalFullscreenProvider>;
}
async function render(props: Parameters<typeof Harness>[0] = {}) { await act(async () => root.render(<Harness {...props}/>)); }
async function click(selector: string) { await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click()); }
function item(label:string) { return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b=>b.textContent?.startsWith(label))!; }
async function choose(label:string) { await act(async () => item(label).click()); }
beforeEach(() => { vi.clearAllMocks(); h.invoke.mockResolvedValue(undefined); vi.stubGlobal("ResizeObserver",class {observe(){}disconnect(){}}); Element.prototype.scrollIntoView=vi.fn(); container=document.createElement("div"); document.body.append(container); root=createRoot(container); });
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it("全屏只有一个退出入口和一组窗口控件，恢复普通模式时去掉专用窗口控件", async()=>{
  await render(); expect(container.querySelectorAll('[aria-label="退出终端全屏（F11）"]')).toHaveLength(1);
  expect(container.querySelectorAll('[aria-label="关闭窗口"]')).toHaveLength(1); expect(container.textContent).not.toContain("全屏 · F11 退出");
  expect(container.querySelector('[aria-label="搜索所有标签"]')).toBeNull();
  await click('[aria-label="退出终端全屏（F11）"]');expect(h.exit).toHaveBeenCalledOnce();
  await render({fullscreen:false});expect(container.querySelector('.terminal-fullscreen-window')).toBeNull();expect(container.querySelector('[aria-label="搜索所有标签"]')).toBeTruthy();
});
it("紧凑提醒保留风险明细和原跳转，跳转前退出全屏",async()=>{
  await render();await click('[aria-label="1 项安全提醒"]');expect(item("命令执行已开启")).toBeTruthy();
  await choose("命令执行已开启");expect(h.exit).toHaveBeenCalledOnce();expect(h.navigate).toHaveBeenCalledWith("security","sec-overview");
});
it("查找与粘贴仍绑定当前窗格，更多菜单保留完整终端功能和外观返回",async()=>{
  await render({closed:true});await click('[aria-label="查找当前终端（Ctrl+Shift+F）"]');expect(h.search).toHaveBeenCalledOnce();
  await click('[aria-label="更多"]');expect(item("粘贴").disabled).toBe(true);expect(item("复制选中").disabled).toBe(false);
  expect(item("发送剪贴板图片").disabled).toBe(true);expect(item("导出终端内容")).toBeTruthy();
  await choose("终端外观");expect(document.activeElement).toBe(item("返回终端操作"));expect(document.body.textContent).toContain("字体");
  await choose("返回终端操作");expect(document.activeElement).toBe(item("复制选中"));expect(item("搜索全部会话")).toBeTruthy();
});
it("停止服务必须确认，取消不调用后端，确认后刷新状态",async()=>{
  await render();await click('[aria-label="更多"]');await choose("停止桥接服务");expect(h.invoke).not.toHaveBeenCalled();
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent==="取消")!.click());expect(h.invoke).not.toHaveBeenCalled();
  await click('[aria-label="更多"]');await choose("停止桥接服务");
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent==="停止服务")!.click());
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("stop_mcp_server");expect(h.changed).toHaveBeenCalledOnce();
});
it("搜索全部会话在顶栏外显示，退出全屏后关闭",async()=>{
  await render();await click('[aria-label="更多"]');await choose("搜索全部会话");
  expect(document.querySelector('[aria-label="搜索全部会话"][role="dialog"]')).toBeTruthy();
  await render({fullscreen:false});expect(document.querySelector('[aria-label="搜索全部会话"][role="dialog"]')).toBeNull();
});
it("停止确认期间状态刷新，不会把停止操作反转成启动",async()=>{
  await render();await click('[aria-label="更多"]');await choose("停止桥接服务");await render({running:false});
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent==="停止服务")!.click());
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("stop_mcp_server");
});
