// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { SshDownloadStatus } from "./SshDownloadStatus";
import type { useSshDownload } from "../../hooks/useSshDownload";
const mocks=vi.hoisted(()=>({open:vi.fn(),reveal:vi.fn(),toast:vi.fn()}));
vi.mock("@tauri-apps/plugin-opener",()=>({openPath:mocks.open,revealItemInDir:mocks.reveal}));
vi.mock("../ui/toast",()=>({toast:mocks.toast}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
const args={connectionId:"a",name:"很长的截图名称.png",remote:"/home/很长的截图名称.png",local:"C:/Downloads/很长的截图名称.png"};
const download={start:vi.fn(),retry:vi.fn(),clear:vi.fn(),busy:false,choosing:false,result:{args,status:"done" as const}};
beforeEach(()=>{vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function show(value:ReturnType<typeof useSshDownload>){await act(async()=>root.render(<SshDownloadStatus download={value} busy={false}/>));}
it("完成显示本机路径和可操作入口，文件名与按钮不挤压换行",async()=>{
  await show(download);
  expect(host.textContent).toContain("下载完成");expect(host.querySelector('[title="'+args.local+'"]')).not.toBeNull();
  const buttons=[...host.querySelectorAll("button")];
  expect(buttons.every(button=>button.className.includes("shrink-0")&&button.className.includes("whitespace-nowrap"))).toBe(true);
  await act(async()=>buttons[0].click());expect(mocks.open).toHaveBeenCalledWith(args.local);
  await act(async()=>buttons[1].click());expect(mocks.reveal).toHaveBeenCalledWith(args.local);
});
it("失败保留详情并提供重试，取消状态不显示错误",async()=>{
  await show({...download,result:{args,status:"failed",error:"网络中断"}});
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("网络中断");
  await act(async()=>host.querySelector("button")!.click());expect(download.retry).toHaveBeenCalledOnce();
  await show({...download,result:{args,status:"cancelled"}});
  expect(host.textContent).toContain("已取消下载");expect(host.querySelector('[role="alert"]')).toBeNull();
});
