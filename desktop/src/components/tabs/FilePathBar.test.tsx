// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilePathBar } from "./FilePathBar";
import { useRemoteNavigation } from "../../hooks/useRemoteNavigation";
import { remoteParentPath } from "../../lib/sshFilePaths";
let root:Root,host:HTMLDivElement;
let navigation:ReturnType<typeof useRemoteNavigation>;
const selected=vi.fn();
function Probe({loading=false}:{loading?:boolean}) {
  navigation=useRemoteNavigation("/home/demo/项目");
  return <FilePathBar path={navigation.path} disabled={loading} loading={loading} onNavigate={path=>{selected(path);navigation.navigate(path);}} onUp={()=>navigation.navigate(remoteParentPath(navigation.path))} canBack={navigation.canBack} canForward={navigation.canForward} onBack={navigation.back} onForward={navigation.forward}/>;
}
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;
const byLabel=(text:string)=>host.querySelector<HTMLButtonElement>(`button[aria-label="${text}"]`)!;
async function render(loading=false){await act(async()=>root.render(<Probe loading={loading}/>));}
async function click(text:string){await act(async()=>button(text).click());}
async function input(value:string){await act(async()=>{const field=host.querySelector<HTMLInputElement>("input")!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});}
async function submit(){await act(async()=>{host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);selected.mockClear();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("面包屑进入祖先后可前进后退，分支导航丢弃旧前进记录",async()=>{
  await render();await click("home");expect(navigation.path).toBe("/home");
  await act(async()=>byLabel("后退到上一目录").click());expect(navigation.path).toBe("/home/demo/项目");
  await act(async()=>byLabel("前进到下一目录").click());expect(navigation.path).toBe("/home");
  await act(async()=>byLabel("后退到上一目录").click());await click("根目录");expect(navigation.path).toBe("/");expect(byLabel("前进到下一目录").disabled).toBe(true);expect(button("上一级").disabled).toBe(true);
});
it("非法远程路径保留输入并提示，合法路径保留内部空格和中文",async()=>{
  await render();await click("编辑路径");await input("~/项目");await submit();expect(selected).not.toHaveBeenCalled();expect(host.querySelector('[role="alert"]')?.textContent).toContain("不会展开");
  await input("/home/项目 空间//src/");await submit();expect(selected).toHaveBeenCalledExactlyOnceWith("/home/项目 空间/src");expect(navigation.path).toBe("/home/项目 空间/src");
});
it("Escape 取消编辑、不改变路径且恢复编辑按钮焦点",async()=>{
  await render();await click("编辑路径");await input("/other");await act(async()=>{host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));});
  expect(navigation.path).toBe("/home/demo/项目");expect(host.querySelector("input")).toBeNull();expect(document.activeElement).toBe(button("编辑路径"));
});
it("加载期间禁止导航和路径提交，重启输入不会绕过锁定",async()=>{
  await render();await click("编辑路径");await input("/other");await render(true);await submit();expect(selected).not.toHaveBeenCalled();expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);expect(byLabel("后退到上一目录").disabled).toBe(true);
  await click("取消");expect(button("编辑路径").disabled).toBe(true);await render(false);expect(document.activeElement).toBe(button("编辑路径"));
});
it("文件定位的父级回退替换当前项，不增加一个无效的文件历史",async()=>{
  await render();await act(async()=>navigation.replace("/home/demo"));expect(navigation.canBack).toBe(false);
  await click("上一级");expect(navigation.path).toBe("/home");await act(async()=>navigation.back());expect(navigation.path).toBe("/home/demo");
});
