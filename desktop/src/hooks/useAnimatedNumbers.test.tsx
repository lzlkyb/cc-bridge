// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAnimatedNumbers } from "./useAnimatedNumbers";

const policy = vi.hoisted(() => ({hidden:false, reduced:false}));
vi.mock("../lib/appVisibility", () => ({useAppHidden:()=>policy.hidden}));
vi.mock("./usePrefersReducedMotion", () => ({usePrefersReducedMotion:()=>policy.reduced}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root, container:HTMLDivElement, now:number, id:number;
let frames:Map<number,FrameRequestCallback>;
function Harness({values,resetKey="",enabled=true}:{values:number[];resetKey?:string;enabled?:boolean}) {
  return <output>{JSON.stringify(useAnimatedNumbers(values,{resetKey,enabled,duration:300}))}</output>;
}
async function render(values:number[],resetKey="",enabled=true){await act(async()=>root.render(<Harness {...{values,resetKey,enabled}}/>));}
function values():number[]{return JSON.parse(container.textContent!);}
async function advance(time:number){now=time;const callbacks=[...frames.values()];frames.clear();await act(async()=>callbacks.forEach(callback=>callback(now)));}
beforeEach(()=>{policy.hidden=false;policy.reduced=false;now=0;id=0;frames=new Map();vi.spyOn(performance,"now").mockImplementation(()=>now);vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;});vi.stubGlobal("cancelAnimationFrame",(key:number)=>frames.delete(key));container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

it("首次显示准确值，相同样本不会持续申请动画帧",async()=>{
  await render([20,100]);expect(values()).toEqual([20,100]);expect(frames.size).toBe(0);
  await render([20,100]);expect(frames.size).toBe(0);
});
it("变化在两个真实值之间收敛，最终精确落到目标且停止申请帧",async()=>{
  await render([20,200]);await render([100,0]);await advance(150);
  expect(values()[0]).toBeGreaterThan(20);expect(values()[0]).toBeLessThan(100);expect(values()[1]).toBeGreaterThan(0);expect(values()[1]).toBeLessThan(200);
  await advance(300);expect(values()).toEqual([100,0]);expect(frames.size).toBe(0);
});
it("中断从当前可见值继续，卸载取消剩余工作",async()=>{
  await render([0]);await render([100]);await advance(100);const shown=values()[0];
  await render([40]);expect(values()[0]).toBe(shown);expect(frames.size).toBe(1);await advance(250);expect(values()[0]).toBeGreaterThan(40);expect(values()[0]).toBeLessThan(shown);
  await act(async()=>root.render(null));expect(frames.size).toBe(0);
});
it("单位、日期和序列断层重置时直接显示新值，不连接旧历史",async()=>{
  await render([19.1],"秒");await render([950],"毫秒");expect(values()).toEqual([950]);expect(frames.size).toBe(0);
  await render([0],"翌日");expect(values()).toEqual([0]);await render([1,2,3],"图");await render([20],"图");expect(values()).toEqual([20]);expect(frames.size).toBe(0);
});
it.each(["hidden","reduced"] as const)("%s 时即时更新并取消动画，恢复时不重播积压变化",async flag=>{
  await render([10]);await render([100]);expect(frames.size).toBe(1);policy[flag]=true;await render([80]);expect(values()).toEqual([80]);expect(frames.size).toBe(0);
  policy[flag]=false;await render([90]);expect(values()).toEqual([90]);expect(frames.size).toBe(0);
});
it("来自较早帧的时间戳不会产生负值或越过样本边界",async()=>{
  now=100;await render([0]);await render([100]);await advance(90);expect(values()).toEqual([0]);await advance(400);expect(values()).toEqual([100]);
});
