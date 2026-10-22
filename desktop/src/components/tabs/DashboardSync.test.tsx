// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardSync } from "./DashboardSync";
const state=vi.hoisted(()=>({dataUpdatedAt:0,isError:false,isRefetchError:false,motion:true}));
vi.mock("../../hooks/useLiveStatus",()=>({useLiveStatus:()=>state}));
vi.mock("../../hooks/useDashboardMotion",()=>({useDashboardMotion:()=>state.motion}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;
async function render(running=true){await act(async()=>root.render(<DashboardSync running={running}/>));}
beforeEach(()=>{vi.useFakeTimers();Object.assign(state,{dataUpdatedAt:0,isError:false,isRefetchError:false,motion:true});container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();});
it("收到状态更新才轻亮，数值没变化也可报告同步，反馈在短时间后停止",async()=>{
  await render();expect(container.textContent).toContain("等待同步");expect(container.querySelector('.dashboard-sync--updated')).toBeNull();
  state.dataUpdatedAt=Date.now();await render();expect(container.textContent).toContain("已更新");expect(container.querySelector('.dashboard-sync--updated')).toBeTruthy();
  await act(async()=>vi.advanceTimersByTime(650));expect(container.querySelector('.dashboard-sync--updated')).toBeNull();await render();expect(container.querySelector('.dashboard-sync--updated')).toBeNull();
});
it("更新失败保留上次时间，不能伪装成成功同步",async()=>{
  state.dataUpdatedAt=Date.now()-5000;await render();state.isRefetchError=true;await render();
  expect(container.textContent).toContain("更新失败");expect(container.firstElementChild?.getAttribute("title")).toContain("上次更新");expect(container.querySelector('.dashboard-sync--updated')).toBeNull();
});
it("隐藏或减弱动效时不安排提示，重新显示不重播旧提示",async()=>{
  await render();state.motion=false;state.dataUpdatedAt=Date.now();await render();expect(container.querySelector('.dashboard-sync--updated')).toBeNull();
  state.motion=true;await render();expect(container.querySelector('.dashboard-sync--updated')).toBeNull();
});
it("停止服务时保持中性状态，更新数据也不提示服务活跃",async()=>{
  await render(false);state.dataUpdatedAt=Date.now();await render(false);expect(container.firstElementChild?.getAttribute("data-tone")).toBe("idle");expect(container.querySelector('.dashboard-sync--updated')).toBeNull();
});
