import { describe, it, expect } from "vitest";
import { findPathsInLine } from "./terminalPathLink";

describe("findPathsInLine（终端输出的远端绝对路径识别）", () => {
  it("基础绝对路径", () => {
    expect(findPathsInLine("see /var/log/syslog for details")).toEqual([
      { path: "/var/log/syslog", startCol: 4, length: 15 },
    ]);
  });
  it("多个路径", () => {
    const r = findPathsInLine("diff /etc/a.conf /etc/b.conf");
    expect(r.map((x) => x.path)).toEqual(["/etc/a.conf", "/etc/b.conf"]);
  });
  it("尾部标点剥掉（句尾/括号路径）", () => {
    expect(findPathsInLine("check /tmp/x.txt.")[0].path).toBe("/tmp/x.txt");
    expect(findPathsInLine("(see /opt/app)")[0].path).toBe("/opt/app");
  });
  it("URL 不匹配（: 前缀排除）", () => {
    expect(findPathsInLine("open http://host/var/www")).toEqual([]);
  });
  it("协议相对 //host/path 不匹配", () => {
    expect(findPathsInLine("mount //srv/share")).toEqual([]);
  });
  it("相对路径中段不匹配（/ 前是 \\w）", () => {
    expect(findPathsInLine("run npm run build/thing or dist/js")).toEqual([]);
  });
  it("纯根目录 / 不算路径", () => {
    expect(findPathsInLine("cd / now")).toEqual([]);
  });
  it("单段根下路径 /tmp 算", () => {
    expect(findPathsInLine("ls /tmp")[0].path).toBe("/tmp");
  });
  it("带点扩展与 @+- 字符", () => {
    expect(findPathsInLine("cat /etc/ssl/certs/ca-bundle.trust.crt")[0].path).toBe(
      "/etc/ssl/certs/ca-bundle.trust.crt",
    );
    expect(findPathsInLine("git@host:/srv/git/x.git")[0]?.path).toBe("/srv/git/x.git");
  });
  it("无斜杠的行直接短路", () => {
    expect(findPathsInLine("hello world")).toEqual([]);
  });
});
