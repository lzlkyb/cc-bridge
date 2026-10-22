// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LogTab } from "./LogTab";
const h=vi.hoisted(()=>({search:"",status:"all",tool:"",reset:vi.fn(),filter:vi.fn()}));
vi.mock("../../hooks/useAuditLog",()=>({useAuditLog:()=>({data:{entries:[],total:0,toolNames:[]},page:1,pageSize:50,search:h.search,tool:h.tool,status:h.status,filter:{},pending:false,isError:false,refetch:vi.fn(),appHidden:false,setSearch:vi.fn(),setPage:vi.fn(),setPageSize:vi.fn(),setToolFilter:vi.fn(),setStatusFilter:h.filter,resetFilters:h.reset})}));
vi.mock("@tanstack/react-query",()=>({useQuery:()=>({data:undefined})}));
vi.mock("../../hooks/useAutoAnimateRM",()=>({useAutoAnimateRM:()=>()=>{}}));
vi.mock("./LogExportMenu",()=>({LogExportMenu:()=>null}));
vi.mock("../ui/toast",()=>({useToast:()=>({toast:vi.fn()})}));
let root:Root,host:HTMLDivElement;
async function render(){await act(async()=>root.render(<LogTab/>));}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);Object.assign(h,{search:"",status:"all",tool:""});vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("确实无历史与筛选无匹配使用不同空态",async()=>{
  await render();expect(host.textContent).toContain("暂无审计记录");expect(host.textContent).not.toContain("清除筛选");
});
it("搜索无匹配说明调整条件，空态可直接清除筛选",async()=>{
  h.search="不存在的内容";await render();expect(host.textContent).toContain("没有匹配的记录");expect(host.textContent).not.toContain("暂无审计记录");
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="清除筛选")!.click());expect(h.reset).toHaveBeenCalledOnce();
});
it("状态筛选具有互斥语义，方向键可改变选择",async()=>{
  h.status="error";await render();const radios=[...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];expect(radios.map(b=>b.getAttribute("aria-checked"))).toEqual(["false","false","true"]);
  await act(async()=>radios[2].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));expect(h.filter).toHaveBeenCalledExactlyOnceWith("all");expect(document.activeElement).toBe(radios[0]);
});
