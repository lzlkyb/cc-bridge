import { describe, expect, it } from "vitest";
import {
  classifySlash,
  filterSlash,
  isClearCommand,
  isSlashTyping,
  SLASH_COMMANDS,
  SLASH_WHITELIST_TEXT,
} from "./ccSlash";

/**
 * 锁住闸门行为。这个模块决定「什么能从输入框出去」：放过不该放的
 * （shell 花招）或拦住该放的（真实命令）都是静默故障，只能靠测试兜。
 */
describe("isSlashTyping", () => {
  it("刚打出斜杠和命令 token 算在输入中", () => {
    expect(isSlashTyping("/")).toBe(true);
    expect(isSlashTyping("/c")).toBe(true);
    expect(isSlashTyping("/compact")).toBe(true);
  });

  it("打了空格（在写参数）、普通文本、多行都不算", () => {
    expect(isSlashTyping("/model opus")).toBe(false);
    expect(isSlashTyping("你好")).toBe(false);
    expect(isSlashTyping("/a\nb")).toBe(false);
    expect(isSlashTyping("")).toBe(false);
  });
});

describe("filterSlash", () => {
  it("空 query 出全量", () => {
    expect(filterSlash("")).toEqual(SLASH_COMMANDS);
  });

  it("按名字包含匹配，不区分大小写", () => {
    expect(filterSlash("comp").map((c) => c.name)).toEqual(["/compact"]);
    expect(filterSlash("MODEL").map((c) => c.name)).toEqual(["/model"]);
    expect(filterSlash("c").map((c) => c.name)).toEqual(["/compact", "/clear"]);
  });

  it("没有匹配返回空列表（面板走空态提示）", () => {
    expect(filterSlash("xyz")).toEqual([]);
  });
});

describe("classifySlash", () => {
  it("普通文本直接放行", () => {
    expect(classifySlash("帮我看下这个 bug")).toEqual({ kind: "none" });
    expect(classifySlash("")).toEqual({ kind: "none" });
  });

  it("白名单命令原样放行（含参数）", () => {
    expect(classifySlash("/compact")).toEqual({ kind: "known", command: SLASH_COMMANDS[0] });
    expect(classifySlash(" /clear ")).toEqual({ kind: "known", command: SLASH_COMMANDS[1] });
    expect(classifySlash("/model opus")).toEqual({ kind: "known", command: SLASH_COMMANDS[2] });
  });

  it("白名单外一律拦截，shell 花招不算命令", () => {
    expect(classifySlash("/foo")).toEqual({ kind: "unknown", name: "/foo" });
    expect(classifySlash("/compact;rm -rf /")).toEqual({ kind: "unknown", name: "/compact;rm" });
    expect(classifySlash("/COMPACT")).toEqual({ kind: "unknown", name: "/COMPACT" });
    expect(classifySlash("/")).toEqual({ kind: "unknown", name: "/" });
    expect(classifySlash("/! ls")).toEqual({ kind: "unknown", name: "/!" });
  });
});

describe("SLASH_WHITELIST_TEXT", () => {
  it("提示文案随白名单自动更新", () => {
    expect(SLASH_WHITELIST_TEXT).toBe("/compact、/clear、/model");
  });
});

/**
 * 清空线靠它从消息内容推导（`MessageList` → `ClearMark`）。判定必须与
 * `classifySlash` 同口径 —— 分叉的话会出现「命令发出去了、线没划」，
 * 而那种不一致只在用户已经忘了上下文的时候才被发现。
 */
describe("isClearCommand", () => {
  it("认 /clear 及其前后空白", () => {
    expect(isClearCommand("/clear")).toBe(true);
    expect(isClearCommand("  /clear  ")).toBe(true);
    // CLI 会把首 token 当命令、后面当参数，所以这里也认
    expect(isClearCommand("/clear 一下")).toBe(true);
  });

  it("其它命令与普通文本都不算", () => {
    expect(isClearCommand("/compact")).toBe(false);
    expect(isClearCommand("/model opus")).toBe(false);
    expect(isClearCommand("帮我 /clear 一下")).toBe(false);
    // 大小写敏感是白名单的既有口径（`/CLEAR` 本来就不会被发送）
    expect(isClearCommand("/CLEAR")).toBe(false);
    expect(isClearCommand("")).toBe(false);
  });
});
