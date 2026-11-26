// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isTypingInUi } from "./typingFocus";

const added: HTMLElement[] = [];
function put(el: HTMLElement) {
  document.body.append(el);
  added.push(el);
  return el;
}
afterEach(() => {
  added.splice(0).forEach((el) => el.remove());
});

describe("isTypingInUi（全局快捷键共用的「正在打字」判据）", () => {
  it("输入框 / 文本域 / contentEditable 聚焦 = 正在打字", () => {
    put(document.createElement("input")).focus();
    expect(isTypingInUi()).toBe(true);
    const ta = put(document.createElement("textarea"));
    ta.focus();
    expect(isTypingInUi()).toBe(true);
    const ce = put(document.createElement("div"));
    ce.contentEditable = "true";
    ce.focus();
    expect(isTypingInUi()).toBe(true);
  });

  it("🔴 终端自己的 textarea 不算：那正是这些快捷键要服务的场景", () => {
    const xterm = put(document.createElement("div"));
    xterm.className = "xterm";
    const ta = document.createElement("textarea");
    xterm.append(ta);
    ta.focus();
    expect(isTypingInUi()).toBe(false);
  });

  it("按钮 / 无焦点元素不算打字", () => {
    put(document.createElement("button")).focus();
    expect(isTypingInUi()).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(isTypingInUi()).toBe(false);
  });
});