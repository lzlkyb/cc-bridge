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
it("无冲突时直接下载，仍由后端禁止覆盖晚出现的同名文件",async()=>{
  mocks.invoke.mockResolvedValue(undefined);let ok=false;
  await act(async()=>{ok=await state.download(args);});
  expect(ok).toBe(true);expect(state.prompt).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("ssh_sftp_get",expect.objectContaining({overwrite:false,local:args.local}));
});
it("首次发现同名时拒绝写入，取消后不发起第二次写入",async()=>{
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
  await act(async()=>{expect(await state.download(args,failed)).toBe(false);});
  expect(failed).toHaveBeenCalledWith(expect.stringContaining("network disconnected"));
  failed.mockClear();mocks.invoke.mockRejectedValueOnce("CCB_CANCELLED");
  await act(async()=>{expect(await state.download(args,failed)).toBe(false);});
  expect(failed).not.toHaveBeenCalled();
});
it("保留两份时上传到新文件名，禁止覆盖原文件", async () => {
  mocks.invoke.mockResolvedValue(undefined);
  let pending!: Promise<boolean>;
  await act(async () => { pending = state.upload({ ...args, remoteExists: true }); });
  await act(async () => state.prompt!.keepBoth!());
  expect(await pending).toBe(true);
  expect(mocks.invoke).toHaveBeenCalledWith("ssh_sftp_put", expect.objectContaining({
    remote: expect.stringMatching(/^\/home\/report \(副本 [0-9a-f]{8}\)\.png$/), overwrite: false, resumable: true,
  }));
});
