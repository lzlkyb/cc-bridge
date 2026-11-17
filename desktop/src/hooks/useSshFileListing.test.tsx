// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSshFileListing } from "./useSshFileListing";
import type { SshFileEntry } from "../lib/types";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("../lib/tauri", () => ({ invoke }));
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useSshFileListing>;
/**
 * 每个用例一个独立连接名。目录快照缓存是**模块级**的（跨挂载保留，这正是它的用途），
 * 用例之间共用 "one" 会让上一个用例写下的快照出现在下一个用例的首帧里。
 */
let conn = "", seq = 0;
function Probe({path,connectionId}: {path:string;connectionId:string}) { api=useSshFileListing(connectionId,path); return null; }
async function render(path="/a",connectionId=conn) { await act(async()=>root.render(<Probe {...{path,connectionId}}/>)); }
function deferred() { let resolve!:(value:SshFileEntry[])=>void, reject!:(error:unknown)=>void; const promise=new Promise<SshFileEntry[]>((yes,no)=>{resolve=yes;reject=no;}); return {resolve,reject,promise}; }
const file=(name:string,isDir=false):SshFileEntry=>({name,isDir,isSymlink:false,size:1,mtime:0});
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);invoke.mockReset();conn=`c${++seq}`;host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("切换路径立即隐藏旧条目，后到的旧结果不能覆盖新目录",async()=>{
  const old=deferred(),next=deferred();invoke.mockResolvedValueOnce([file("old.txt")]).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await render();expect(api.entries[0].name).toBe("old.txt");
  await act(async()=>{void api.refresh();});expect(api.loading).toBe(true);
  await render("/b");expect(api.entries).toEqual([]);expect(api.loading).toBe(true);
  await act(async()=>next.resolve([file("new.txt")]));expect(api.entries[0].name).toBe("new.txt");
  await act(async()=>old.resolve([file("wrong.txt")]));expect(api.entries[0].name).toBe("new.txt");expect(api.loading).toBe(false);
});
it("旧连接的失败不会污染新连接，同一路径也必须区分连接",async()=>{
  const old=deferred();invoke.mockReturnValueOnce(old.promise).mockResolvedValueOnce([file("second.txt")]);
  await render();await render("/a","two");await act(async()=>old.reject(new Error("old server offline")));
  expect(api.error).toBeNull();expect(api.entries[0].name).toBe("second.txt");
});
it("同一路径的刷新以最后一次为准，旧 finally 不能解除新请求的 loading",async()=>{
  const first=deferred(),second=deferred();invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render();await act(async()=>{void api.refresh();});await act(async()=>first.resolve([file("old")]));
  expect(api.loading).toBe(true);expect(api.entries).toEqual([]);
  await act(async()=>second.resolve([file("z"),file("dir",true),file("a")]));expect(api.entries.map(e=>e.name)).toEqual(["dir","a","z"]);
});
it("失败释放 loading、清空条目并允许重试，不回写虚假成功",async()=>{
  invoke.mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce([file("ok")]);await render();
  expect(api.loading).toBe(false);expect(api.error).toContain("permission denied");expect(api.entries).toEqual([]);
  await act(async()=>{await api.refresh();});expect(api.error).toBeNull();expect(api.entries[0].name).toBe("ok");
});
it("上传结束持有的旧回调在导航或卸载后不会发起目录请求",async()=>{
  invoke.mockResolvedValue([file("x")]);await render();const oldRefresh=api.refresh;await render("/b");
  const calls=invoke.mock.calls.length;await act(async()=>{await oldRefresh();});expect(invoke).toHaveBeenCalledTimes(calls);
  const refresh=api.refresh;await act(async()=>root.render(null));await refresh();expect(invoke).toHaveBeenCalledTimes(calls);
});
it("重开同一目录先用上次快照顶上，但刷新仍在进行（不能把缓存伪装成已完成）",async()=>{
  const live=deferred(),fresh=deferred();
  invoke.mockResolvedValueOnce([file("app.log")]).mockReturnValueOnce(live.promise).mockReturnValueOnce(fresh.promise);
  await render();
  expect(api.entries[0].name).toBe("app.log");
  // 面板关掉再打开 = 卸载后重新挂载；这次请求故意悬挂，模拟慢链路。
  await act(async()=>root.render(null));
  await render();
  expect(api.entries.map(e=>e.name)).toEqual(["app.log"]);
  expect(api.loading).toBe(true);
  // 没列过的目录不能借用别人的快照。
  await render("/fresh");
  expect(api.entries).toEqual([]);
  expect(api.loading).toBe(true);
});
it("目录来回切时，回切那一步直接命中快照",async()=>{
  const back=deferred();
  invoke
    .mockResolvedValueOnce([file("a.txt")])
    .mockResolvedValueOnce([file("b.txt")])
    .mockReturnValueOnce(back.promise);
  await render("/a");await render("/b");
  expect(api.entries[0].name).toBe("b.txt");
  await render("/a");
  expect(api.entries.map(e=>e.name)).toEqual(["a.txt"]);
  expect(api.loading).toBe(true);
});
