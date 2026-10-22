// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalTabsBar } from "./TerminalTabsBar";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { SshConnection } from "../../lib/types";
const h=vi.hoisted(()=>({activate:vi.fn(),disconnect:vi.fn(),close:vi.fn()}));
vi.mock("./TerminalFullscreenContext",()=>({useTerminalFullscreenActions:()=>({})}));
const conn={id:"one",name:"示例服务器",host:"192.0.2.10"} as SshConnection;
const sessions:SshSessionRef[]=[{sessionId:"a",tabId:"ta",conn,closedReason:null},{sessionId:"split",tabId:"ts",conn,closedReason:null,splitOnly:true},{sessionId:"b",tabId:"tb",conn,closedReason:null},{sessionId:"c",tabId:"tc",conn,closedReason:"已断开"}];
let root:Root,host:HTMLDivElement;
function Probe(){const [active,setActive]=useState("a");return <TerminalTabsBar sessions={sessions} activeId={active} metaBySession={{}} onActivate={id=>{h.activate(id);setActive(id);}} onDisconnect={h.disconnect} onCloseTab={h.close} onNewTerminal={null} onToggleSplit={null} splitActive={false}/>;}
const tabs=()=>[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
async function key(index:number,key:string,ctrlKey=false){const event=new KeyboardEvent("keydown",{key,ctrlKey,bubbles:true,cancelable:true});await act(async()=>{tabs()[index].dispatchEvent(event);});return event;}
beforeEach(async()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);Element.prototype.scrollIntoView=vi.fn();vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Probe/>));});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("方向键只在会话标签中切换，跳过分屏副格并保持唯一 Tab 入口",async()=>{
  expect(tabs()).toHaveLength(3);expect(tabs().map(b=>b.tabIndex)).toEqual([0,-1,-1]);await key(0,"ArrowRight");expect(h.activate).toHaveBeenLastCalledWith("b");expect(document.activeElement).toBe(tabs()[1]);expect(tabs().map(b=>b.tabIndex)).toEqual([-1,0,-1]);
  await key(1,"End");expect(h.activate).toHaveBeenLastCalledWith("c");await key(2,"ArrowRight");expect(h.activate).toHaveBeenLastCalledWith("a");await key(0,"ArrowLeft");expect(h.activate).toHaveBeenLastCalledWith("c");await key(2,"Home");expect(h.activate).toHaveBeenLastCalledWith("a");
});
it("修饰键和终端方向输入不被标签栏处理",async()=>{
  expect((await key(0,"ArrowRight",true)).defaultPrevented).toBe(false);expect((await key(0,"ArrowDown")).defaultPrevented).toBe(false);expect(h.activate).not.toHaveBeenCalled();
});
it("连接标签执行断开，已断开标签才执行关闭，不混淆按钮用途",async()=>{
  const buttons=[...host.querySelectorAll<HTMLButtonElement>(".terminal-session-close")];expect(buttons[0].getAttribute("aria-label")).toContain("断开会话，保留历史");expect(buttons[2].getAttribute("aria-label")).toContain("关闭标签");
  await act(async()=>buttons[0].click());expect(h.disconnect).toHaveBeenCalledExactlyOnceWith("a");expect(h.close).not.toHaveBeenCalled();await act(async()=>buttons[2].click());expect(h.close).toHaveBeenCalledExactlyOnceWith("c");
});
