// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalTabsBar } from "./TerminalTabsBar";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { SshConnection } from "../../lib/types";
import type { TermTabMeta } from "../../lib/terminalTabMeta";
import type { ProgramStatus } from "../../lib/terminalProgramStatus";
const h=vi.hoisted(()=>({activate:vi.fn(),disconnect:vi.fn(),close:vi.fn()}));
vi.mock("./TerminalFullscreenContext",()=>({useTerminalFullscreenActions:()=>({})}));
const conn={id:"one",name:"示例服务器",host:"192.0.2.10"} as SshConnection;
const sessions:SshSessionRef[]=[{sessionId:"a",tabId:"ta",conn,closedReason:null},{sessionId:"split",tabId:"ts",conn,closedReason:null,splitOnly:true},{sessionId:"b",tabId:"tb",conn,closedReason:null},{sessionId:"c",tabId:"tc",conn,closedReason:"已断开"}];
let root:Root,host:HTMLDivElement;
function Probe(){const [active,setActive]=useState("a");return <TerminalTabsBar sessions={sessions} activeId={active} metaBySession={{}} onActivate={id=>{h.activate(id);setActive(id);}} onDisconnect={h.disconnect} onCloseTab={h.close} onNewTerminal={null} onToggleSplit={null} splitActive={false}/>;}
const tabs=()=>[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
async function key(index:number,key:string,ctrlKey=false){const event=new KeyboardEvent("keydown",{key,ctrlKey,bubbles:true,cancelable:true});await act(async()=>{tabs()[index].dispatchEvent(event);});return event;}
beforeEach(async()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});Element.prototype.scrollIntoView=vi.fn();vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Probe/>));});
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

/* ===== CC 运行态徽标（OSC 7501）===== */
const st=(state:ProgramStatus["state"],extra:Partial<ProgramStatus>={}):ProgramStatus=>({state,kind:null,app:"claude-code",title:null,msg:null,progress:null,...extra});
const meta=(agent:ProgramStatus|null,title:string|null=null,agentUnread=false):TermTabMeta=>({title,progress:null,bellAt:null,agent,agentUnread});
async function renderBar(metaBySession:Record<string,TermTabMeta>,list:SshSessionRef[],onActivate:(id:string)=>void=()=>{}){
  await act(async()=>root.render(<TerminalTabsBar sessions={list} activeId={list[0].sessionId} metaBySession={metaBySession} onActivate={onActivate} onDisconnect={()=>{}} onCloseTab={()=>{}} onNewTerminal={null} onToggleSplit={null} splitActive={false}/>));
}
const badges=()=>[...host.querySelectorAll<HTMLElement>('[role="tab"] [role="img"]')];
const pills=()=>[...host.querySelectorAll<HTMLButtonElement>(".terminal-tab-pill")];
const pillBy=(s:string)=>pills().find(p=>p.textContent?.includes(s))??null;
const pill=()=>pillBy("待处理");

it("标签徽标：转圈=干活中 / 琥珀点=等确认 / ✓=已完成 / △=出错；idle 不占位",async()=>{
  const list:SshSessionRef[]=["w","b","d","e","i"].map(id=>({sessionId:id,tabId:`t-${id}`,conn,closedReason:null}));
  await renderBar({w:meta(st("working",{progress:40})),b:meta(st("blocked",{kind:"permission",msg:"允许执行 rm -rf build 吗？"})),d:meta(st("done")),e:meta(st("error")),i:meta(st("idle"))},list);
  // 五个标签只有四个徽标：idle 是「安静待命」，不该在标签上占位
  expect(badges().map(b=>b.getAttribute("aria-label"))).toEqual(["运行中 40%","等待确认","已完成","出错"]);
  // working 必须转圈（且 animate-spin 在收托盘的暂停清单里）
  expect(badges()[0].querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
  // blocked 是琥珀**填充**圆点，两套主题都留了 halo
  expect(badges()[1].className).toContain("bg-amber-500");
  expect(badges()[1].className).toContain("rounded-full");
  // tooltip 带 CC 上报的正文：它到底在问什么
  expect(badges()[1].getAttribute("title")).toContain("rm -rf build 吗？");
  expect(badges()[2].querySelector("svg")).not.toBeNull();
  expect(badges()[3].querySelector("svg")).not.toBeNull();
});

it("🔴 会话已断开就不再显示运行态：标签上挂着转圈而实际早断了，比不显示更糟",async()=>{
  await renderBar({a:meta(st("working"))},[{sessionId:"a",tabId:"ta",conn,closedReason:"已断开"}]);
  expect(badges()).toHaveLength(0);
});

it("旧版 CC（有 TUI 标题却无任何上报）在 tooltip 补弱提示，纯 shell 标签不加",async()=>{
  const list:SshSessionRef[]=[{sessionId:"a",tabId:"ta",conn,closedReason:null},{sessionId:"b",tabId:"tb",conn,closedReason:null},{sessionId:"c",tabId:"tc",conn,closedReason:null}];
  // a：旧版 CC（有 OSC 标题、无状态）② b：纯 shell（既无标题也无状态）③ c：新版 CC（有上报但恰好 idle）
  await renderBar({a:meta(null,"✳ 重构鉴权"),c:meta(st("idle"))},list);
  expect(badges()).toHaveLength(0);
  const labels=[...host.querySelectorAll<HTMLElement>(".terminal-session-tab span[title]")].filter(el=>el.textContent?.startsWith("示例服务器"));
  expect(labels).toHaveLength(3);
  expect(labels[0].getAttribute("title")).toContain("OSC 7501");
  expect(labels[1].getAttribute("title")).not.toContain("OSC 7501");
  expect(labels[2].getAttribute("title")).not.toContain("OSC 7501");
});

it("🔴 未读画实色、已读压暗：跑一下午回来，亮着的那几个才是真的还没看过的",async()=>{
  const list:SshSessionRef[]=["u","r"].map(id=>({sessionId:id,tabId:`t-${id}`,conn,closedReason:null}));
  // u：后台跑完了但没切过去看 ⇒ 未读；r：切过去看过 ⇒ 已读
  await renderBar({u:meta(st("done"),null,true),r:meta(st("done"),null,false)},list);
  const [unread,read]=badges();
  expect(unread.className).not.toContain("opacity-45");
  expect(read.className).toContain("opacity-45");
  // 已读不删、只压暗：做过的事忽然消失比一直亮着更让人困惑
  expect(read.getAttribute("aria-label")).toBe("已完成");
});

it("blocked 未读才呼吸；已读后停掉呼吸与光晕，但仍留琥珀圆点",async()=>{
  const list:SshSessionRef[]=["u","r"].map(id=>({sessionId:id,tabId:`t-${id}`,conn,closedReason:null}));
  await renderBar({u:meta(st("blocked",{kind:"permission"}),null,true),r:meta(st("blocked",{kind:"permission"}),null,false)},list);
  const [unread,read]=badges();
  expect(unread.className).toContain("animate-pulse");
  expect(read.className).not.toContain("animate-pulse");
  expect(read.className).toContain("bg-amber-500");
});

it("working 不受已读影响：一直在干活，没有「读过了」这回事",async()=>{
  await renderBar({w:meta(st("working"),null,false)},[{sessionId:"w",tabId:"tw",conn,closedReason:null}]);
  // 转圈必须还在（needsAttention=false ⇒ 不降级）
  expect(badges()[0].className).not.toContain("opacity-45");
  expect(badges()[0].querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
  expect(badges()[0].className).not.toContain("opacity-50");
});

/* ===== G5 待处理汇总药丸 ===== */
const threeTabs=():SshSessionRef[]=>["a","b","c"].map(id=>({sessionId:id,tabId:`t-${id}`,conn,closedReason:null}));

it("G5：未读汇总成药丸，数字等于未读数，tooltip 列出「哪几个、什么事」",async()=>{
  await renderBar({a:meta(st("done"),null,true),b:meta(st("working")),c:meta(st("blocked",{kind:"permission"}),null,true)},threeTabs());
  const p=pill()!;
  expect(p.textContent).toContain("2 个待处理");
  // 数字说几个，tooltip 说哪几个——省掉一次「为了搞清情况而做的跳转」
  expect(p.getAttribute("title")).toContain("已完成");
  expect(p.getAttribute("title")).toContain("等待确认");
});

it("G5：点药丸跳到下一个待处理；当前标签本身就在名单里时往后走一个，不能点了没反应",async()=>{
  const activate=vi.fn();
  // activeId 固定取 list[0]="a"，而 a 恰好也是未读
  await renderBar({a:meta(st("done"),null,true),b:meta(st("working")),c:meta(st("blocked"),null,true)},threeTabs(),activate);
  await act(async()=>pill()!.click());
  expect(activate).toHaveBeenCalledExactlyOnceWith("c");
});

it("G5：没有未读时药丸整块消失（不留灰掉的 0）",async()=>{
  await renderBar({a:meta(st("done")),b:meta(st("working"))},threeTabs());
  expect(pill()).toBeNull();
});

it("G5：断开的标签进「已断开」那一档，不进待处理——它没有待办，但等你重连",async()=>{
  const list:SshSessionRef[]=[{sessionId:"a",tabId:"ta",conn,closedReason:"已断开"}];
  await renderBar({a:meta(st("done"),null,true)},list);
  // 断线标签上徽标已归零，残留的未读也不该让「待处理」重新长出来
  expect(pill()).toBeNull();
  expect(pillBy("已断开")!.textContent).toContain("1 个已断开");
});

it("两档并存：琥珀说「去看」，红说「去重连」，各点各的",async()=>{
  const activate=vi.fn();
  const list:SshSessionRef[]=[
    {sessionId:"a",tabId:"ta",conn,closedReason:null},
    {sessionId:"b",tabId:"tb",conn,closedReason:null},
    {sessionId:"c",tabId:"tc",conn,closedReason:"网络断开"},
  ];
  await renderBar({a:meta(st("blocked",{kind:"permission"}),null,true),b:meta(st("working"))},list,activate);
  expect(pills()).toHaveLength(2);
  expect(pillBy("已断开")!.getAttribute("title")).toContain("已断开");
  await act(async()=>pillBy("已断开")!.click());
  expect(activate).toHaveBeenCalledExactlyOnceWith("c");
});
