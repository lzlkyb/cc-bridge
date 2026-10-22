// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileTable } from "./SshFileRow";
import type { SshFileEntry } from "../../lib/types";
vi.mock("../../hooks/useAutoAnimateRM",()=>({useAutoAnimateRM:()=>()=>{}}));
const dir:SshFileEntry={name:"项目文件夹",isDir:true,isSymlink:false,size:0,mtime:0};
const file:SshFileEntry={...dir,name:"report.txt",isDir:false};
const open=vi.fn(),download=vi.fn(),remove=vi.fn(),retry=vi.fn();
let root:Root,host:HTMLDivElement;
async function render(loading=false,busy=false,error:string|null=null) {await act(async()=>root.render(<FileTable entries={[dir,file]} loading={loading} busy={busy} error={error} onOpenDir={open} onDownload={download} onRemove={remove} onRetry={retry}/>));}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("文件夹有原生键盘按钮和名称，激活只打开一次",async()=>{
  await render();const button=host.querySelector<HTMLButtonElement>('[aria-label="打开文件夹 项目文件夹"]')!;
  expect(button.tagName).toBe("BUTTON");button.focus();expect(document.activeElement).toBe(button);
  await act(async()=>button.click());expect(open).toHaveBeenCalledExactlyOnceWith(dir.name);expect(remove).not.toHaveBeenCalled();
});
it.each([[true,false],[false,true]])("loading=%s busy=%s 时行和行内动作均被锁定",async(loading,busy)=>{
  await render(loading,busy);expect([...host.querySelectorAll<HTMLButtonElement>("tbody button")].every(b=>b.disabled)).toBe(true);
  await act(async()=>{host.querySelector("tr[aria-selected],tbody tr")!.dispatchEvent(new MouseEvent("click",{bubbles:true}));});expect(open).not.toHaveBeenCalled();
});
it("行内下载不冒泡打开，错误处可直接重试",async()=>{
  await render();await act(async()=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="下载")!.click());
  expect(download).toHaveBeenCalledExactlyOnceWith(file.name);expect(open).not.toHaveBeenCalled();
  await render(false,false,"permission denied");expect(host.querySelector('[role="alert"]')?.textContent).toContain("permission denied");
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="重试")!.click());expect(retry).toHaveBeenCalledOnce();
});
