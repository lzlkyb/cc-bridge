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
  const powers=[...host.querySelectorAll<HTMLButtonElement>(".terminal-session-power")];expect(powers).toHaveLength(3);
  expect(powers[0].getAttribute("aria-label")).toContain("断开会话，保留历史");expect(powers[0].disabled).toBe(false);
  expect(powers[2].getAttribute("aria-label")).toContain("已断开");expect(powers[2].disabled).toBe(true);
  // 已断开的标签才多出一个关闭按钮
  const closes=[...host.querySelectorAll<HTMLButtonElement>(".terminal-session-close")];expect(closes).toHaveLength(1);
  expect(closes[0].getAttribute("aria-label")).toContain("关闭标签");
  await act(async()=>powers[0].click());expect(h.disconnect).toHaveBeenCalledExactlyOnceWith("a");expect(h.close).not.toHaveBeenCalled();
  await act(async()=>closes[0].click());expect(h.close).toHaveBeenCalledExactlyOnceWith("c");
});
it("🔴 双击 × 不再连带删标签：断开后原坐标是禁用的断开按钮，关闭是右侧另一个按钮",async()=>{
  function DoubleProbe(){
    const [closed,setClosed]=useState(false);
    const s:SshSessionRef={sessionId:"a",tabId:"ta",conn,closedReason:closed?"已断开 (0)":null};
    return <TerminalTabsBar sessions={[s]} activeId="a" metaBySession={{}} onActivate={()=>{}} onDisconnect={id=>{h.disconnect(id);setClosed(true);}} onCloseTab={h.close} onNewTerminal={null} onToggleSplit={null} splitActive={false}/>;
  }
  await act(async()=>root.render(<DoubleProbe/>));
  const power=host.querySelector<HTMLButtonElement>(".terminal-session-power")!;
  const box=host.querySelector<HTMLDivElement>(".terminal-session-close");
  expect(box).toBeNull();
  await act(async()=>power.click());
  expect(h.disconnect).toHaveBeenCalledExactlyOnceWith("a");
  // 位置不变：还是同一个元素，只是禁用；关闭按钮追加在它右侧（双击第二下打不到）
  expect(power.isConnected).toBe(true);expect(power.disabled).toBe(true);
  const close=host.querySelector<HTMLButtonElement>(".terminal-session-close")!;
  expect(close).not.toBe(power);
  expect(power.compareDocumentPosition(close)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  h.disconnect.mockClear();
  await act(async()=>power.click());
  expect(h.disconnect).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
});

it("Ctrl+Shift+G 打开「搜索所有标签」，且不把 \x07 发给远端",async()=>{
  const header=host.querySelector<HTMLDivElement>(".terminal-tabs-header")!;
  const query=()=>document.querySelector<HTMLInputElement>('input[placeholder="搜索所有标签的终端内容"]');
  const press=async()=>{
    const e=new KeyboardEvent("keydown",{key:"g",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true});
    await act(async()=>{document.body.dispatchEvent(e);});
    return e;
  };
  // 页面不可见（App 用 display:none 保活本页）时不抢：jsdom 里 offsetParent 恒为 null
  expect((await press()).defaultPrevented).toBe(false);
  expect(query()).toBeNull();
  // 模拟真实布局：有了 offsetParent 才接管
  Object.defineProperty(header,"offsetParent",{configurable:true,get:()=>document.body});
  const ev=await press();
  // 🔴 defaultPrevented 是这个用例的关键：不拦的话 xterm 会把 Ctrl+G 映射成 \x07（BEL）
  expect(ev.defaultPrevented).toBe(true);
  expect(query()).not.toBeNull();
});

it("🔴 双击标签名可重命名（同名多终端唯一的区分手段），Esc 取消、清空恢复默认名",async()=>{
  const rename=vi.fn();
  await act(async()=>root.render(<TerminalTabsBar sessions={sessions} activeId="a" metaBySession={{}} onActivate={()=>{}} onDisconnect={()=>{}} onCloseTab={()=>{}} onNewTerminal={null} onToggleSplit={null} splitActive={false} onRename={rename}/>));
  const label=()=>host.querySelector<HTMLElement>(".terminal-session-tab span[title]")!;
  expect(label().textContent).toBe("示例服务器");
  await act(async()=>label().dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  const input=host.querySelector<HTMLInputElement>('input[aria-label="重命名标签"]')!;
  expect(input).not.toBeNull();
  // Esc：不改名
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(host.querySelector('input[aria-label="重命名标签"]')).toBeNull();
  expect(rename).not.toHaveBeenCalled();
  // Enter：提交新名字
  await act(async()=>label().dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  const again=host.querySelector<HTMLInputElement>('input[aria-label="重命名标签"]')!;
  // React 受控输入：必须走原生 setter，否则 value tracker 认为没变、onChange 不触发
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;
  await act(async()=>{setter.call(again,"构建");again.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>again.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
  expect(rename).toHaveBeenCalledExactlyOnceWith("ta","构建");
});
