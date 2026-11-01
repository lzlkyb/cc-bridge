// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshFileBrowser } from "./SshFileBrowser";
import type { SshConnection, SshFileEntry } from "../../lib/types";
const h=vi.hoisted(()=>({invoke:vi.fn(),download:vi.fn(),toast:vi.fn()}));
vi.mock("../../lib/tauri",()=>({invoke:h.invoke}));
vi.mock("../ui/toast",()=>({toast:h.toast}));
vi.mock("@tanstack/react-query",()=>({useQuery:()=>({data:{platform:"windows"}})}));
vi.mock("../../hooks/useAutoAnimateRM",()=>({useAutoAnimateRM:()=>()=>{}}));
vi.mock("./useFileBrowserDrop",()=>({useFileBrowserDrop:()=>({paneRef:{current:null},zone:null})}));
vi.mock("./useSshTransfer",()=>({useSshTransfer:()=>({transfer:null,prompt:null})}));
vi.mock("./useSshFileForms",()=>({useSshFileForms:()=>({download:{busy:false},uploadOpen:false,handleDownload:h.download})}));
vi.mock("./SshDownloadStatus",()=>({SshDownloadStatus:()=>null}));
const conn={id:"one",name:"测试服务器",host:"192.0.2.10",port:22,username:"demo"} as SshConnection;
const folder:SshFileEntry={name:"child",isDir:true,isSymlink:false,size:0,mtime:0};
const file:SshFileEntry={...folder,name:"old.txt",isDir:false};
let root:Root,host:HTMLDivElement;
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;
async function click(text:string){await act(async()=>button(text).click());}
async function render(initialPath="/parent"){await act(async()=>root.render(<SshFileBrowser conn={conn} initialPath={initialPath} onBack={()=>{}}/>));}
function deferred(){let resolve!:(rows:SshFileEntry[])=>void,reject!:(e:unknown)=>void;const promise=new Promise<SshFileEntry[]>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);Element.prototype.scrollIntoView=vi.fn();localStorage.clear();vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("切目录期间路径已更新时，旧行不可操作，完成后只展示新条目",async()=>{
  const next=deferred();h.invoke.mockResolvedValueOnce([folder,file]).mockReturnValueOnce(next.promise);await render();await click("child");
  expect(host.textContent).toContain("/parent/child");expect(host.textContent).not.toContain("old.txt");expect(button("上传").disabled).toBe(true);expect(button("新建").disabled).toBe(true);
  expect(h.download).not.toHaveBeenCalled();expect(localStorage.getItem("cc-bridge.upload-dir.one")).toBe("/parent");
  await act(async()=>next.resolve([{...file,name:"new.txt"}]));expect(host.textContent).toContain("new.txt");expect(button("上传").disabled).toBe(false);
  expect(localStorage.getItem("cc-bridge.upload-dir.one")).toBe("/parent/child");
});
it("原地刷新保留列表但锁定目录、下载与删除",async()=>{
  const next=deferred();h.invoke.mockResolvedValueOnce([folder,file]).mockReturnValueOnce(next.promise);await render();await click("刷新");
  expect(button("child").disabled).toBe(true);expect(button("下载").disabled).toBe(true);expect(button("删除").disabled).toBe(true);
  await act(async()=>host.querySelector("tbody tr")!.dispatchEvent(new MouseEvent("click",{bubbles:true})));expect(h.invoke).toHaveBeenCalledTimes(2);
  await act(async()=>next.resolve([folder,file]));expect(button("child").disabled).toBe(false);
});
it("进入失败目录不覆盖上次成功目录，重试入口可恢复且失败期间禁止上传",async()=>{
  h.invoke.mockResolvedValueOnce([folder,file]).mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce([]);
  await render();await click("child");expect(host.querySelector('[role="alert"]')?.textContent).toContain("permission denied");expect(button("上传").disabled).toBe(true);
  expect(localStorage.getItem("cc-bridge.upload-dir.one")).toBe("/parent");await click("重试");expect(button("上传").disabled).toBe(false);
  expect(h.invoke).toHaveBeenLastCalledWith("ssh_sftp_list",{connectionId:"one",path:"/parent/child"});
});
it("文件初始定位回退到父级期间，不把文件路径记成上传目录",async()=>{
  const pending=deferred();h.invoke.mockResolvedValueOnce([{...file,name:"/parent/note.md"}]).mockReturnValueOnce(pending.promise);
  await render("/parent/note.md");expect(localStorage.getItem("cc-bridge.upload-dir.one")).toBeNull();
  await act(async()=>pending.resolve([{...file,name:"note.md"}]));expect(localStorage.getItem("cc-bridge.upload-dir.one")).toBe("/parent");
});
it("🔴 多选后可批量删除：一次确认、串行执行、目录不进批量清单",async()=>{
  const other:SshFileEntry={...file,name:"b.txt"};
  h.invoke.mockResolvedValue([folder,file,other]);
  await render();
  const rows=()=>[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")];
  // 选中两个文件 + 一个目录（Ctrl+点击），验证目录被排除在批量删除之外
  await act(async()=>rows()[1].dispatchEvent(new MouseEvent("click",{bubbles:true})));
  await act(async()=>rows()[2].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true})));
  await act(async()=>rows()[0].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true})));
  expect(host.textContent).toContain("已选 3 个");
  await click("删除所选");
  // 确认框是 portal 到 body 的，得在 document 上找
  const page=()=>document.body.textContent??"";
  expect(page()).toContain("确定要删除选中的 2 个文件吗？");
  h.invoke.mockClear();
  const confirm=[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent?.trim()==="删除")!;
  await act(async()=>confirm.click());
  expect(h.invoke.mock.calls.filter(c=>c[0]==="ssh_sftp_remove").map(c=>c[1].path))
    .toEqual(["/parent/b.txt","/parent/old.txt"]);
});
it("双击普通文件即下载（不用再瞄行尾按钮）",async()=>{
  h.invoke.mockResolvedValue([folder,file]);await render();
  await act(async()=>[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")][1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(h.download).toHaveBeenCalledExactlyOnceWith("old.txt");
});
it("断线时文件面板给出「重新连接」出口，而不是只能一路返回",async()=>{
  const reconnect=vi.fn();h.invoke.mockResolvedValue([folder,file]);
  await act(async()=>root.render(<SshFileBrowser conn={conn} initialPath="/parent" disconnected onReconnect={reconnect} onBack={()=>{}}/>));
  const alert=host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("已断开");
  await act(async()=>[...alert.querySelectorAll<HTMLButtonElement>("button")][0].click());
  expect(reconnect).toHaveBeenCalledOnce();
});
it("换目录才清空多选；同目录内的重渲染不清",async()=>{
  h.invoke.mockResolvedValue([folder,file]);
  await render();
  const rows=()=>[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")];
  await act(async()=>rows()[1].dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(host.textContent).toContain("已选 1 个");
  // 同目录内再点一次（一次 state 更新 + 重渲染）：选择必须还在。
  // 守住 effect 的依赖写法——把整个 sel 对象写进依赖会让每次渲染都清一遍。
  await act(async()=>rows()[1].dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(host.textContent).toContain("已选 1 个");
  // 换目录后名字失效，必须清空。
  await click("child");
  expect(host.textContent).not.toContain("已选");
});
