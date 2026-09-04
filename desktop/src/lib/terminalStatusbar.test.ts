import { describe, it, expect } from "vitest";
import {
  parseOsc7,
  parseOsc133,
  parseOsc1337,
  shortenPath,
  formatUptime,
} from "./terminalStatusbar";

// xterm 的 `parser.registerOscHandler(ident, cb)` 回调收到的 data 是 ident **之后**的内容
// （含首个 `;`），与 ident 本身无关。下面的用例都按这个口径喂。

describe("parseOsc7（cwd）", () => {
  it("标准 file:// 路径", () => {
    expect(parseOsc7("file://host/home/me/app")).toBe("/home/me/app");
  });
  it("根目录", () => {
    expect(parseOsc7("file://host/")).toBe("/");
  });
  it("含空格/特殊字符的 URL 编码路径", () => {
    expect(parseOsc7("file://host/opt/my%20app")).toBe("/opt/my app");
  });
  it("非 file:// 返回 null", () => {
    expect(parseOsc7("http://evil")).toBeNull();
    expect(parseOsc7("/home/me")).toBeNull();
  });
});

describe("parseOsc133（退出码）", () => {
  it("D;<code> 解析退出码", () => {
    expect(parseOsc133("D;0")).toBe(0);
    expect(parseOsc133("D;137")).toBe(137);
  });
  it("只认 D 段，C（命令开始）不解析", () => {
    expect(parseOsc133("C")).toBeNull();
    expect(parseOsc133("A")).toBeNull();
  });
  it("缺退出码或非法值返回 null", () => {
    expect(parseOsc133("D;")).toBeNull();
    expect(parseOsc133("D;abc")).toBeNull();
  });
});

describe("parseOsc1337（私有键值）", () => {
  it("探针回执 Shell=", () => {
    expect(parseOsc1337("Shell=-bash")).toEqual({ shell: "-bash" });
  });
  it("git 分支 Git=", () => {
    expect(parseOsc1337("Git=main")).toEqual({ git: "main" });
    expect(parseOsc1337("Git=feature/login")).toEqual({ git: "feature/login" });
  });
  it("其它键忽略", () => {
    expect(parseOsc1337("Foo=bar")).toEqual({});
    expect(parseOsc1337("no-equals-sign")).toEqual({});
  });
});

describe("shortenPath", () => {
  it("短路径原样返回", () => {
    expect(shortenPath("/home/me")).toBe("/home/me");
  });
  it("超过 keep 层截断为 …/ 前缀", () => {
    expect(shortenPath("/a/b/c/d/e", 3)).toBe("…/c/d/e");
  });
  it("空串返回空串", () => {
    expect(shortenPath("")).toBe("");
  });
});

describe("formatUptime", () => {
  it("秒级", () => {
    expect(formatUptime(5_000)).toBe("5s");
    expect(formatUptime(59_000)).toBe("59s");
  });
  it("分钟级", () => {
    expect(formatUptime(60_000)).toBe("1m");
    expect(formatUptime(59 * 60_000 + 59_000)).toBe("59m");
  });
  it("小时级补零", () => {
    expect(formatUptime(65 * 60_000 + 3_000)).toBe("1h05m");
  });
  it("负值夹到 0", () => {
    expect(formatUptime(-100)).toBe("0s");
  });
});
