import { describe, expect, it } from "vitest";
import { isInitialFileListing, remoteFileName, remoteParentPath } from "./sshFilePaths";
const file = {name:"/home/demo/report final.png",isDir:false,isSymlink:false,size:10,mtime:0};
describe("远程文件入口", () => {
  it("本机保存只使用文件名，不包含远端目录，保留空格中文", () => {
    expect(remoteFileName(file.name)).toBe("report final.png");
    expect(remoteFileName("/home/中文/截图.png")).toBe("截图.png");
    expect(remoteParentPath(file.name)).toBe("/home/demo");
    expect(remoteParentPath("/file")).toBe("/");
    expect(remoteParentPath("/")).toBe("/");
  });
  it("识别成功的 ls(file)，不会把仅有一个文件的目录误当文件", () => {
    expect(isInitialFileListing(file.name,[file])).toBe(true);
    expect(isInitialFileListing("/home/demo",[{...file,name:"report final.png"}])).toBe(false);
    expect(isInitialFileListing(file.name,[{...file,isDir:true}])).toBe(false);
    expect(isInitialFileListing(file.name,[])).toBe(false);
  });
});
