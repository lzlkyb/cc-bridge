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
// 预标身份是独立命令（ssh_file_viewer）。本文件不测预标：mock 掉，避免每次挂载
// 多一次 invoke 打乱各用例的 mockResolvedValueOnce 序列（预标集成见
// SshFileRow.access.test.tsx，那里直接喂 viewer 给 FileTable）。
vi.mock("../../hooks/useSshFileViewer",()=>({useSshFileViewer:()=>null}));
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
it("🔴 双击普通文件即打开编辑器（不再下载；下载仍在行尾按钮）",async()=>{
  // 列目录与读文件分开应答，避免读命令拿到目录数组
  h.invoke.mockImplementation((cmd:string)=>cmd==="ssh_file_read"
    ?Promise.resolve({content:"hello\nworld\n",size:12,mtime:1700000000,truncated:false,lineEnding:"lf"})
    :Promise.resolve([folder,file]));
  await render();
  await act(async()=>[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")][1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(h.download).not.toHaveBeenCalled();
  // 覆盖层出现：顶栏有文件名与「用本机编辑器打开」
  expect(button("用本机编辑器打开")).toBeTruthy();
  expect(host.textContent).toContain("/parent");
  expect(h.invoke.mock.calls.some(c=>c[0]==="ssh_file_read"&&c[1].path==="/parent/old.txt")).toBe(true);
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
  // 换目录后名字失效，必须清空。批量条常驻，所以清空的证据是「已选」消失、
  // 计数槽退回「共 N 项」且批量操作全部不可用——不是批量条整个消失。
  await click("child");
  const bar=host.querySelector('[role="toolbar"]')!;
  expect(bar).not.toBeNull();
  expect(bar.textContent).not.toContain("已选");
  expect(bar.textContent).toContain("共 2 项");
  expect(button("下载所选").disabled).toBe(true);
  expect(button("移动到…").disabled).toBe(true);
  expect(button("取消选择").disabled).toBe(true);
});
it("🔴 未选中时批量条也已挂载：点第一行不会让列表整体位移",async()=>{
  // jsdom 量不到像素，零位移的可测代理是「结构恒定」：未选中态批量条必须在 DOM 里，
  // 且与选中态同处 FileTable 之上。条件挂载 ⇒ 这条用例必红。
  h.invoke.mockResolvedValue([folder,file]);
  await render();
  const bar=host.querySelector('[role="toolbar"]')!;
  expect(bar).not.toBeNull();
  expect(bar.getAttribute("data-selected")).toBe("false");
  expect(bar.textContent).toContain("共 2 项");
  expect(button("下载所选").disabled).toBe(true);
  // 选中后同一节点仍在（只是换文案）——不是卸载再挂载
  await act(async()=>[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")][1].dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(host.querySelector('[role="toolbar"]')).toBe(bar);
  expect(bar.getAttribute("data-selected")).toBe("true");
  expect(bar.textContent).toContain("已选 1 个");
});
it("🔴 行尾重命名端到端：对话框预填当前名 → 提交 ssh_sftp_rename（overwrite=false）",async()=>{
  h.invoke.mockResolvedValue([folder,file]);
  await render();
  const fileRow=[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")][1];
  await act(async()=>[...fileRow.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="重命名")!.click());
  // 对话框 portal 到 body
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("正在重命名");
  const input=dialog.querySelector<HTMLInputElement>("#ssh-rename-input")!;
  expect(input.value).toBe("old.txt");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"new.txt");
  await act(async()=>input.dispatchEvent(new Event("input",{bubbles:true})));
  h.invoke.mockClear();h.invoke.mockResolvedValue([]);   // 成功后紧跟一次列目录刷新
  await act(async()=>[...dialog.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="重命名")!.click());
  const renameCalls=h.invoke.mock.calls.filter(c=>c[0]==="ssh_sftp_rename");
  expect(renameCalls).toHaveLength(1);
  expect(renameCalls[0][1]).toEqual({connectionId:"one",path:"/parent/old.txt",new_name:"new.txt",overwrite:false});
  expect(h.invoke.mock.calls.some(c=>c[0]==="ssh_sftp_list")).toBe(true);   // 成功后原地刷新
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("🔴 过滤后批量条按 view 口径计数：已选数与「移动到…」实际作用对象一致",async()=>{
  h.invoke.mockResolvedValue([folder,file,{...file,name:"note.md"}]);
  await render();
  // 先点一行唤出批量条，再全选 3 个，然后过滤到只剩 1 个：批量条的计数与
  // 移动对象都必须是 chosen（过滤后仍显示的那 1 个），不能让被滤掉名字里的
  // 另外两个漏出去。
  await act(async()=>[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")][1].dispatchEvent(new MouseEvent("click",{bubbles:true})));
  await click("全选");
  expect(host.textContent).toContain("已选 3 个");
  const filter=host.querySelector<HTMLInputElement>('input[aria-label="按名称过滤当前目录"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(filter,".txt");
  await act(async()=>filter.dispatchEvent(new Event("input",{bubbles:true})));
  expect([...host.querySelectorAll<HTMLTableRowElement>("tbody tr")]).toHaveLength(1);
  expect(host.textContent).toContain("已选 1 个");
  await click("移动到…");
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("移动到");
  expect(dialog.querySelector<HTMLInputElement>("#ssh-move-dir")!.value).toBe("/parent");   // 默认当前目录
});
