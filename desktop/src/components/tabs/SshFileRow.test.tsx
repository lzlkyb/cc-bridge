// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileTable } from "./SshFileRow";
import type { SshFileEntry } from "../../lib/types";
import { DEFAULT_SORT } from "../../lib/sshFileSort";
vi.mock("../../hooks/useAutoAnimateRM",()=>({useAutoAnimateRM:()=>()=>{}}));
const dir:SshFileEntry={name:"项目文件夹",isDir:true,isSymlink:false,size:0,mtime:0};
const file:SshFileEntry={...dir,name:"report.txt",isDir:false};
const linkDir:SshFileEntry={...file,name:"logs-link",isSymlink:true,linkTarget:"/var/log/nginx",linkTargetIsDir:true};
const linkFile:SshFileEntry={...file,name:"current.conf",isSymlink:true,linkTarget:"conf.d/real.conf",linkTargetIsDir:false};
const linkDangling:SshFileEntry={...file,name:"dangling",isSymlink:true,linkTarget:null,linkTargetIsDir:false};
const open=vi.fn(),download=vi.fn(),remove=vi.fn(),retry=vi.fn(),select=vi.fn(()=>true);
const rename=vi.fn(),move=vi.fn(),toggleSort=vi.fn();
/** 批次③新增的必需 props：行尾重命名/移动 + 排序态。 */
const batch3={onRename:rename,onMove:move,sort:DEFAULT_SORT,onToggleSort:toggleSort};
let root:Root,host:HTMLDivElement;
async function render(loading=false,busy=false,error:string|null=null) {await act(async()=>root.render(<FileTable entries={[dir,file]} loading={loading} busy={busy} error={error} onOpenDir={open} onDownload={download} onRemove={remove} onRetry={retry} {...batch3}/>));}
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
  await act(async()=>root.render(<FileTable entries={[dir,file]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onRetry={retry} onSelect={select} onActivateFile={activate} {...batch3}/>));
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
  await act(async()=>root.render(<FileTable entries={[dir,file]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onRetry={retry} onSelect={select} {...batch3}/>));
  await act(async()=>host.querySelector("tbody tr")!.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true})));
  expect(select).toHaveBeenCalledWith(dir.name,expect.objectContaining({ctrlKey:true}));expect(open).not.toHaveBeenCalled();
});
it("🔴 软链到目录：整行可进入、行内显示 → 目标、大小列按目录计（不显示链接自身字节数）",async()=>{
  await act(async()=>root.render(<FileTable entries={[linkDir]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} {...batch3}/>));
  const row=host.querySelector("tbody tr")!;
  expect(host.querySelector<HTMLButtonElement>('[aria-label="打开文件夹 logs-link"]')!.tagName).toBe("BUTTON");
  expect(row.textContent).toContain("→ /var/log/nginx");
  expect([...row.querySelectorAll("td")][1].textContent).toBe("—");
  await act(async()=>row.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(open).toHaveBeenCalledExactlyOnceWith(linkDir.name);
});
it("🔴 软链到文件：单击只选中、双击进编辑器（后端保存已解析到真实路径，不再悄悄替换链接）",async()=>{
  const activate=vi.fn();
  await act(async()=>root.render(<FileTable entries={[linkFile]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onSelect={select} onActivateFile={activate} {...batch3}/>));
  const row=host.querySelector("tbody tr")!;
  expect(row.querySelector('td:first-child button')).toBe(null);
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
  await act(async()=>root.render(<FileTable entries={[linkDangling]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} onActivateFile={activate} {...batch3}/>));
  const row=host.querySelector("tbody tr")!;
  expect(row.textContent).toContain("链接");
  expect(row.textContent).not.toContain("→");
  await act(async()=>row.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));
  expect(activate).toHaveBeenCalledExactlyOnceWith(linkDangling.name);
});
it("🔴 行尾重命名/移动各就各位，点击不冒泡打开目录",async()=>{
  await render();
  // 按钮每行都有，断言必须落在具体行上（第一行是目录，别抓到它的）
  const fileRow=()=>[...host.querySelectorAll<HTMLTableRowElement>("tbody tr")][1];
  const inFileRow=(text:string)=>[...fileRow().querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
  await act(async()=>inFileRow("重命名").click());
  expect(rename).toHaveBeenCalledExactlyOnceWith(file);expect(open).not.toHaveBeenCalled();
  await act(async()=>inFileRow("移动").click());
  expect(move).toHaveBeenCalledExactlyOnceWith(file);expect(open).not.toHaveBeenCalled();
});
it("🔴 表头点击交给轮换；箭头只在激活列出现（三列同亮会被读成三个排序同时生效）",async()=>{
  await render();
  // 默认排序 = 名称升序：只有名称列有 aria-sort 与箭头
  const sorted=host.querySelector('th[aria-sort="ascending"]')!;
  expect(sorted.textContent).toContain("名称");
  expect(host.querySelectorAll('thead th[aria-sort="none"]').length).toBe(2);      // 大小/修改时间（操作列无 aria-sort）
  expect(host.querySelectorAll("thead span[aria-hidden]").length).toBe(1);      // 全局只有一个 ▲
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>("thead button")].find(b=>b.textContent?.includes("大小"))!.click());
  expect(toggleSort).toHaveBeenCalledExactlyOnceWith("size");
});
it("过滤无命中给的是「改关键词」提示，不是上传引导（目录此时并不空）",async()=>{
  await act(async()=>root.render(<FileTable entries={[]} loading={false} busy={false} error={null} onOpenDir={open} onDownload={download} onRemove={remove} filterActive {...batch3}/>));
  expect(host.textContent).toContain("没有匹配的条目");
  expect(host.textContent).not.toContain("目录为空");
});
