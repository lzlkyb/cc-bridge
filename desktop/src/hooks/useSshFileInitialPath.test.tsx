// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useSshFileInitialPath } from "./useSshFileInitialPath";
import type { SshFileEntry } from "../lib/types";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root,current:string,highlight:string|undefined;
function Harness({initial,error=null,entries=[]}:{initial:string;error?:string|null;entries?:SshFileEntry[]}) {
  const [path,setPath]=useState(initial);current=path;highlight=useSshFileInitialPath(initial,error,path,setPath,entries);return null;
}
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("ls 对文件成功也切回父目录并选中文件",async()=>{
  const initial="/home/demo/截图.png";
  await act(async()=>root.render(<Harness initial={initial} entries={[{name:initial,isDir:false,isSymlink:false,size:12,mtime:0}]}/>));
  expect(current).toBe("/home/demo");expect(highlight).toBe("截图.png");
});
it("目录只有一个普通文件时仍停留该目录",async()=>{
  await act(async()=>root.render(<Harness initial="/home/demo" entries={[{name:"截图.png",isDir:false,isSymlink:false,size:12,mtime:0}]}/>));
  expect(current).toBe("/home/demo");expect(highlight).toBeUndefined();
});
it("初次失败只回退一次，不向根目录无限回退",async()=>{
  await act(async()=>root.render(<Harness initial="/home/demo/missing" error="not found"/>));
  expect(current).toBe("/home/demo");expect(highlight).toBe("missing");
});
