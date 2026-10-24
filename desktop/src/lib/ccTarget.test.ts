import { describe, expect, it } from "vitest";
import { pickClaudePath } from "./ccTarget";

describe("pickClaudePath", () => {
  const local = { connId: null, path: "/usr/local/bin/claude" };
  const remoteA = { connId: "conn-a", path: "/home/u/.local/bin/claude" };

  it("显式给的路径优先于探测结果", () => {
    expect(pickClaudePath("/opt/claude", remoteA, "conn-a")).toBe("/opt/claude");
  });

  it("同一目标时用探测到的绝对路径", () => {
    expect(pickClaudePath(null, remoteA, "conn-a")).toBe("/home/u/.local/bin/claude");
  });

  /// 这条是远端唯一的护栏：换了连接还沿用上一个目标的路径，
  /// 远端会 exec 一个不存在的文件，报错只显示「No such file」。
  it("换了目标就不用旧目标的探测结果", () => {
    expect(pickClaudePath(null, remoteA, "conn-b")).toBeNull();
    expect(pickClaudePath(null, { connId: null, path: "C:/node/claude.cmd" }, "conn-a")).toBeNull();
  });

  it("本机目标用本机探测结果", () => {
    expect(pickClaudePath(null, local, null)).toBe("/usr/local/bin/claude");
  });

  /// 返回 null 让 Rust 侧兜底成 "claude"，前端不重复写默认值。
  it("什么都没探到时返回 null", () => {
    expect(pickClaudePath(null, null, "conn-a")).toBeNull();
    expect(pickClaudePath("   ", null, null)).toBeNull();
    expect(pickClaudePath(null, { connId: "conn-a", path: "  " }, "conn-a")).toBeNull();
  });

  it("显式路径与探测路径都去空白", () => {
    expect(pickClaudePath("  /opt/claude  ", null, null)).toBe("/opt/claude");
    expect(pickClaudePath(null, { connId: null, path: "  /usr/bin/claude  " }, null)).toBe(
      "/usr/bin/claude",
    );
  });
});
