// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecurityOverview } from "./SecurityOverview";
import type { StaticStatus } from "../../lib/types";
const h=vi.hoisted(()=>({invoke:vi.fn(),toast:vi.fn(),saved:vi.fn()}));
vi.mock("../../lib/tauri",()=>({invoke:h.invoke}));
vi.mock("../ui/toast",()=>({useToast:()=>({toast:h.toast})}));
vi.mock("../../hooks/usePrefersReducedMotion",()=>({usePrefersReducedMotion:()=>true}));
let root:Root,host:HTMLDivElement;
const status={whitelistEnabled:true,readonlyMode:false,shellEnabled:false,rateLimitEnabled:true,auditEnabled:true,backupEnabled:true} as StaticStatus;
const toggle=(name:string)=>host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)!;
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;
async function render(data:StaticStatus|null=status){await act(async()=>root.render(<SecurityOverview status={data ?? undefined} onSaved={h.saved}/>));}
async function click(text:string){await act(async()=>button(text).click());}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);localStorage.clear();vi.clearAllMocks();h.invoke.mockResolvedValue({});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("保存中阻止重复与相关开关，完成后才反馈已保存",async()=>{
  let resolve!:(v:unknown)=>void;h.invoke.mockReturnValue(new Promise(yes=>{resolve=yes;}));await render();
  await act(async()=>{toggle("只读模式").click();toggle("只读模式").click();});
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("save_config",{patch:{readonlyMode:true}});
  expect(host.querySelector('[role="status"]')?.textContent).toContain("保存中");expect([...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].every(b=>b.disabled)).toBe(true);
  expect(h.saved).not.toHaveBeenCalled();await act(async()=>resolve({}));expect(h.saved).toHaveBeenCalledOnce();expect(host.textContent).toContain("已保存");
});
it("保存失败保留真实开关和行内错误，可再次操作重试",async()=>{
  h.invoke.mockRejectedValueOnce(new Error("disk full"));await render();await act(async()=>toggle("只读模式").click());
  expect(toggle("只读模式").getAttribute("aria-checked")).toBe("false");expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");expect(h.saved).not.toHaveBeenCalled();
  await act(async()=>toggle("只读模式").click());expect(h.invoke).toHaveBeenCalledTimes(2);expect(host.querySelector('[role="alert"]')).toBeNull();expect(h.saved).toHaveBeenCalledOnce();
});
it("危险变更仍须确认，开启命令仍须知晓风险，取消不落盘",async()=>{
  await render();await act(async()=>toggle("路径白名单校验").click());expect(h.invoke).not.toHaveBeenCalled();await click("取消");
  await act(async()=>toggle("命令执行").click());expect(button("确定开启").disabled).toBe(true);expect(h.invoke).not.toHaveBeenCalled();
  await act(async()=>document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await click("确定开启");
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("save_config",{patch:{shellEnabled:true}});
});
it("状态未返回时不能提交默认安全值",async()=>{
  await render(null);expect([...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].every(b=>b.disabled)).toBe(true);expect(h.invoke).not.toHaveBeenCalled();
});
