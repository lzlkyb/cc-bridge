// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSshDownload } from "./useSshDownload";
const mocks = vi.hoisted(() => ({save:vi.fn(),download:vi.fn(),toast:vi.fn()}));
vi.mock("@tauri-apps/plugin-dialog",()=>({save:mocks.save}));
vi.mock("@tauri-apps/api/path",()=>({downloadDir:async()=>"C:/Downloads",join:async(...parts:string[])=>parts.join("/"),dirname:async(path:string)=>path.slice(0,path.lastIndexOf("/"))}));
vi.mock("../components/ui/toast",()=>({toast:mocks.toast}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root, host:HTMLDivElement, state:ReturnType<typeof useSshDownload>;
function Harness() { state=useSshDownload("server-a","/home/demo",mocks.download); return null; }
beforeEach(async()=>{
  vi.clearAllMocks(); localStorage.clear(); mocks.save.mockResolvedValue("D:/Work/report.png"); mocks.download.mockResolvedValue(true);
  host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Harness/>));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});
describe("原生另存为下载",()=>{
  it("完整远端路径只取 basename 作为默认文件名，远端下载路径不重复拼接",async()=>{
    await act(async()=>state.start("/home/demo/report.png"));
    expect(mocks.save).toHaveBeenCalledWith({title:"下载文件到本机",defaultPath:"C:/Downloads/report.png"});
    expect(mocks.download.mock.calls[0][0]).toEqual({connectionId:"server-a",name:"report.png",remote:"/home/demo/report.png",local:"D:/Work/report.png"});
    expect(state.result?.status).toBe("done"); expect(localStorage.getItem("cc-bridge.download-directory")).toBe("D:/Work");
    expect(mocks.download.mock.calls[0][2]).toBe(true);
  });
  it("取消选择不下载，下一次默认记住已选目录",async()=>{
    localStorage.setItem("cc-bridge.download-directory","E:/Reports");mocks.save.mockResolvedValue(null);
    await act(async()=>state.start("中文 report.png"));
    expect(mocks.save.mock.calls[0][0].defaultPath).toBe("E:/Reports/中文 report.png");
    expect(mocks.download).not.toHaveBeenCalled();expect(state.busy).toBe(false);
  });
  it("重复点击只开一个选择器，组件关闭后不再启动传输",async()=>{
    let resolve!:(value:string)=>void;mocks.save.mockReturnValue(new Promise<string>(r=>{resolve=r;}));
    let pending!:Promise<void>;
    await act(async()=>{pending=state.start("a.png");void state.start("b.png");});
    expect(mocks.save).toHaveBeenCalledOnce();expect(state.choosing).toBe(true);
    await act(async()=>root.render(null));await act(async()=>{resolve("D:/Work/a.png");await pending;});
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("失败保留文件与位置，可直接重试，不重开选择器",async()=>{
    mocks.download.mockImplementationOnce(async(_args:unknown,onFailure:(message:string)=>void)=>{onFailure("网络中断");return false;});
    await act(async()=>state.start("report.png"));
    expect(state.result?.status).toBe("failed");expect(state.result?.error).toBe("网络中断");
    await act(async()=>state.retry());
    expect(mocks.save).toHaveBeenCalledOnce();expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.download.mock.calls[1][0]).toEqual(mocks.download.mock.calls[0][0]);expect(state.result?.status).toBe("done");
  });
  it("传输取消不冒充失败；选择器报错有反馈且可再次操作",async()=>{
    mocks.download.mockResolvedValue(false);await act(async()=>state.start("report.png"));
    expect(state.result?.status).toBe("cancelled");expect(state.result?.error).toBeUndefined();
    mocks.save.mockRejectedValueOnce(new Error("dialog denied"));await act(async()=>state.start("report.png"));
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("dialog denied"),"error");expect(state.busy).toBe(false);
  });
});
