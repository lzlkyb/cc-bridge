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
