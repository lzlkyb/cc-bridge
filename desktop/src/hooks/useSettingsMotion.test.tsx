// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useSettingsCategoryMotion } from "./useSettingsCategoryMotion";
import { useSettingsMenuMotion } from "./useSettingsMenuMotion";
import { SETTINGS_CATEGORIES } from "../lib/settingsCategories";
let root:Root,host:HTMLDivElement,reduced=false,hidden=false;
const animations:{target:HTMLElement;frames:Keyframe[];options:KeyframeAnimationOptions;cancel:ReturnType<typeof vi.fn>}[]=[];
let resize:ResizeObserverCallback;
function Probe({current="set-app",deep=false,active=true,query=""}:{current?:string;deep?:boolean;active?:boolean;query?:string}) {
  const content=useRef<HTMLDivElement>(null),nav=useRef<HTMLElement>(null);
  useSettingsCategoryMotion(content,SETTINGS_CATEGORIES,current,active,deep);
  const plate=useSettingsMenuMotion(nav,current,query,false);
  return <><nav ref={nav}><div ref={plate} hidden/>{!query&&SETTINGS_CATEGORIES.map((s,i)=><button key={s.id} aria-current={s.id===current?"page":undefined} data-test-index={i}>{s.label}</button>)}</nav>
    <div ref={content}>{SETTINGS_CATEGORIES.map(s=><div key={s.id} className="settings-category-panel" hidden={s.id!==current}><div className="settings-category-content"><input defaultValue="草稿"/></div></div>)}</div></>;
}
beforeEach(()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);reduced=false;hidden=false;animations.length=0;
  vi.spyOn(document,"hidden","get").mockImplementation(()=>hidden);
  vi.stubGlobal("matchMedia",()=>({matches:reduced}));
  vi.stubGlobal("ResizeObserver",class{constructor(cb:ResizeObserverCallback){resize=cb;}observe(){}disconnect(){}});
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){return {top:Number(this.dataset.testIndex||0)*60,left:0,width:180,height:50,bottom:50,right:180,x:0,y:0,toJSON(){}};});
  Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
  Object.defineProperty(HTMLElement.prototype,"animate",{configurable:true,value:function(this:HTMLElement,frames:Keyframe[],options:KeyframeAnimationOptions){const entry={target:this,frames,options,cancel:vi.fn()};animations.push(entry);return entry;}});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete (HTMLElement.prototype as Partial<HTMLElement>).animate;delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;vi.restoreAllMocks();vi.unstubAllGlobals();});
async function render(current="set-app",deep=false,active=true,query=""){await act(async()=>root.render(<Probe current={current} deep={deep} active={active} query={query}/>));}
const contents=()=>animations.filter(a=>a.target.className==="settings-category-content");
it("首次不播，切换方向正确，重复选择不重播且保留草稿和滚动",async()=>{
  await render();expect(animations).toHaveLength(0);
  const input=host.querySelector("input")!,panel=host.querySelector<HTMLElement>(".settings-category-panel")!;input.value="未保存";panel.scrollTop=120;
  await render("set-terminal");expect(contents()[0].frames[0].transform).toBe("translateY(6px)");expect(contents()[0].options.duration).toBe(200);
  await render("set-terminal");expect(contents()).toHaveLength(1);
  await render();expect(contents()[1].frames[0].transform).toBe("translateY(-6px)");expect(host.querySelector("input")).toBe(input);expect(input.value).toBe("未保存");expect(panel.scrollTop).toBe(120);
});
it("快速切换取消旧动画，尺寸监听首次回调不取消新底板动画",async()=>{
  await render();await render("set-terminal");const first=[...animations];
  await act(async()=>resize([],{} as ResizeObserver));expect(first.every(a=>a.cancel.mock.calls.length===0)).toBe(true);
  await render("set-network");expect(first.every(a=>a.cancel.mock.calls.length===1)).toBe(true);expect(host.querySelector('[aria-current=page]')?.textContent).toBe("网络与接入");
});
it("搜索直达仅淡入，搜索列表不残留分类底板",async()=>{
  await render();await render("set-terminal",true);expect(contents()[0].frames.every(f=>f.transform==="none")).toBe(true);expect(contents()[0].options.duration).toBe(140);
  await render("set-terminal",false,true,"字号");expect(host.querySelector("nav>div")?.hasAttribute("hidden")).toBe(true);
});
it("减弱动效与隐藏文档不创建动画，失活取消内容运动",async()=>{
  await render();reduced=true;await render("set-terminal");expect(animations).toHaveLength(0);
  reduced=false;hidden=true;await render("set-network");expect(animations).toHaveLength(0);
  hidden=false;await render("set-files");const content=contents()[contents().length-1];await render("set-files",false,false);expect(content.cancel).toHaveBeenCalledOnce();
});
