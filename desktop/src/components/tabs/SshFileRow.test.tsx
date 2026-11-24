// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileTable } from "./SshFileRow";
import type { SshFileEntry } from "../../lib/types";
vi.mock("../../hooks/useAutoAnimateRM",()=>({useAutoAnimateRM:()=>()=>{}}));
const dir:SshFileEntry={name:"项目文件夹",isDir:true,isSymlink:false,size:0,mtime:0};
const file:SshFileEntry={...dir,name:"report.txt",isDir:false};
const linkDir:SshFileEntry={...file,name:"logs-link",isSymlink:true,linkTarget:"/var/log/nginx",linkTargetIsDir:true};
const linkFile:SshFileEntry={...file,name:"current.conf",isSymlink:true,linkTarget:"conf.d/real.conf",linkTargetIsDir:false};
const linkDangling:SshFileEntry={...file,name:"dangling",isSymlink:true,linkTarget:null,linkTargetIsDir:false};
const open=vi.fn(),download=vi.fn(),remove=vi.fn(),retry=vi.fn(),select=vi.fn(()=>true);
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
it("🔴 双击普通文件即打开编辑器；单击只选中（以前双击完全没动作）",async()=>{
  const activate=vi.fn();
  await act(async()=>root.render(<FileTable entries={[dir,file]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onRetry={retry} onSelect={select} onActivateFile={activate}/>));
  const row=[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")][1];
  await act(async()=>row.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(activate).not.toHaveBeenCalled();            // 单击不打开
  expect(select).toHaveBeenCalledExactlyOnceWith(file.name,expect.anything());
  await act(async()=>row.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(activate).toHaveBeenCalledExactlyOnceWith(file.name);expect(open).not.toHaveBeenCalled();
  // 下载不再是双击语义：仍在行尾按钮上，且不冒泡
  expect(download).not.toHaveBeenCalled();
});
it("带修饰键的点击交给多选，不再顺手打开目录",async()=>{
  await act(async()=>root.render(<FileTable entries={[dir,file]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onRetry={retry} onSelect={select}/>));
  await act(async()=>host.querySelector("tbody tr")!.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true})));
  expect(select).toHaveBeenCalledWith(dir.name,expect.objectContaining({ctrlKey:true}));expect(open).not.toHaveBeenCalled();
});
it("🔴 软链到目录：整行可进入、行内显示 → 目标、大小列按目录计（不显示链接自身字节数）",async()=>{
  await act(async()=>root.render(<FileTable entries={[linkDir]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove}/>));
  const row=host.querySelector("tbody tr")!;
  expect(host.querySelector<HTMLButtonElement>('[aria-label="打开文件夹 logs-link"]')!.tagName).toBe("BUTTON");
  expect(row.textContent).toContain("→ /var/log/nginx");
  expect([...row.querySelectorAll("td")][1].textContent).toBe("—");
  await act(async()=>row.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(open).toHaveBeenCalledExactlyOnceWith(linkDir.name);
});
it("🔴 软链到文件：单击只选中、双击进编辑器（后端保存已解析到真实路径，不再悄悄替换链接）",async()=>{
  const activate=vi.fn();
  await act(async()=>root.render(<FileTable entries={[linkFile]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onSelect={select} onActivateFile={activate}/>));
  const row=host.querySelector("tbody tr")!;
  expect(host.querySelector('tbody button[aria-label]')).toBe(null);   // 名字不是按钮，没有键盘直达
  expect(row.textContent).toContain("→ conf.d/real.conf");
  await act(async()=>row.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(activate).not.toHaveBeenCalled();
  expect(select).toHaveBeenCalledExactlyOnceWith(linkFile.name,expect.anything());
  await act(async()=>row.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(activate).toHaveBeenCalledExactlyOnceWith(linkFile.name);
  expect(open).not.toHaveBeenCalled();
});
it("软链目标解析失败：退到「链接」徽标，双击仍给编辑器出路",async()=>{
  const activate=vi.fn();
  await act(async()=>root.render(<FileTable entries={[linkDangling]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onActivateFile={activate}/>));
  const row=host.querySelector("tbody tr")!;
  expect(row.textContent).toContain("链接");
  expect(row.textContent).not.toContain("→");
  await act(async()=>row.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(activate).toHaveBeenCalledExactlyOnceWith(linkDangling.name);
});
