// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSshTransfer } from "./useSshTransfer";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),toast:vi.fn()}));
vi.mock("../../lib/tauri",()=>({invoke:mocks.invoke,listen:async()=>()=>{}}));
vi.mock("../ui/toast",()=>({toast:mocks.toast}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement,state:ReturnType<typeof useSshTransfer>;
const args={connectionId:"server",name:"report.png",remote:"/home/report.png",local:"C:/Downloads/report.png"};
function Harness(){state=useSshTransfer();return null;}
beforeEach(async()=>{vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Harness/>));});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("原生保存已确认目的地时不再弹重复覆盖确认，后端仍负责临时文件写入",async()=>{
  mocks.invoke.mockResolvedValue(undefined);let ok=false;
  await act(async()=>{ok=await state.download(args,undefined,true);});
  expect(ok).toBe(true);expect(state.prompt).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("ssh_sftp_get",expect.objectContaining({overwrite:true,local:args.local}));
});
it("没有原生确认的调用仍先拒绝覆盖，取消后不发起第二次写入",async()=>{
  mocks.invoke.mockRejectedValueOnce("CCB_TARGET_EXISTS: exists");let pending!:Promise<boolean>;
  await act(async()=>{pending=state.download(args);});
  expect(state.prompt?.path).toBe(args.local);
  await act(async()=>state.dismissPrompt());expect(await pending).toBe(false);
  expect(mocks.invoke).toHaveBeenCalledOnce();
});
it("确认覆盖后才重试；真实失败回传详情，取消不冒充错误",async()=>{
  mocks.invoke.mockRejectedValueOnce("CCB_TARGET_EXISTS").mockResolvedValueOnce(undefined);let pending!:Promise<boolean>;
  await act(async()=>{pending=state.download(args);});
  await act(async()=>state.prompt!.confirm());expect(await pending).toBe(true);
  expect(mocks.invoke.mock.calls[1][1].overwrite).toBe(true);
  const failed=vi.fn();mocks.invoke.mockRejectedValueOnce("network disconnected");
  await act(async()=>{expect(await state.download(args,failed,true)).toBe(false);});
  expect(failed).toHaveBeenCalledWith(expect.stringContaining("network disconnected"));
  failed.mockClear();mocks.invoke.mockRejectedValueOnce("CCB_CANCELLED");
  await act(async()=>{expect(await state.download(args,failed,true)).toBe(false);});
  expect(failed).not.toHaveBeenCalled();
});
