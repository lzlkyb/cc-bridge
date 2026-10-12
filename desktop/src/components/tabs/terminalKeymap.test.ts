import { describe, it, expect, vi } from "vitest";
import { attachTerminalKeymap, type TerminalKeyActions } from "./terminalKeymap";
import type { Terminal } from "@xterm/xterm";

/**
 * 终端快捷键拦截的回归钉子。
 *
 * 🔴 核心回归（2026-10-12 粘贴重复 bug）：Ctrl+V 分支必须 preventDefault。
 * xterm 的 keydown 监听丢弃返回值且从不 preventDefault——只 return false 时浏览器
 * 默认粘贴照常执行，paste 事件落进 xterm 隐藏 textarea，原生路径（handlePasteEvent
 * → onData → ssh_input）会再发一份，加上 Tauri 剪贴板路径共两条，粘贴内容重复。
 */

function makeFakeTerm() {
  let handler: ((e: KeyboardEvent) => boolean) | undefined;
  const term = {
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => {
      handler = h;
    },
    selectAll: vi.fn(),
  };
  return { term: term as unknown as Terminal, getHandler: () => handler! };
}

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: "keydown",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: "",
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function makeActions() {
  return {
    paste: vi.fn(),
    copy: vi.fn(),
    openSearch: vi.fn(),
  } satisfies TerminalKeyActions;
}

describe("attachTerminalKeymap", () => {
  it("Ctrl+V：调用 paste 且必须 preventDefault（粘贴重复回归钉）", () => {
    const { term, getHandler } = makeFakeTerm();
    const actions = makeActions();
    attachTerminalKeymap(term, { current: actions });
    const e = keyEvent({ ctrlKey: true, key: "v" });
    const ret = getHandler()(e);
    expect(actions.paste).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(ret).toBe(false);
  });

  it("Ctrl+Shift+V：同一条判定覆盖，同样 preventDefault", () => {
    const { term, getHandler } = makeFakeTerm();
    const actions = makeActions();
    attachTerminalKeymap(term, { current: actions });
    const e = keyEvent({ ctrlKey: true, shiftKey: true, key: "V" });
    const ret = getHandler()(e);
    expect(actions.paste).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(ret).toBe(false);
  });

  it("Ctrl+C（无 shift）：不拦截，原样放行给 xterm（SIGINT 刚需）", () => {
    const { term, getHandler } = makeFakeTerm();
    const actions = makeActions();
    attachTerminalKeymap(term, { current: actions });
    const e = keyEvent({ ctrlKey: true, key: "c" });
    const ret = getHandler()(e);
    expect(ret).toBe(true);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(actions.paste).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+C：走 copy，不触发 paste", () => {
    const { term, getHandler } = makeFakeTerm();
    const actions = makeActions();
    attachTerminalKeymap(term, { current: actions });
    const e = keyEvent({ ctrlKey: true, shiftKey: true, key: "C" });
    const ret = getHandler()(e);
    expect(actions.copy).toHaveBeenCalledTimes(1);
    expect(actions.paste).not.toHaveBeenCalled();
    expect(ret).toBe(false);
  });

  it("普通按键：不拦截", () => {
    const { term, getHandler } = makeFakeTerm();
    const actions = makeActions();
    attachTerminalKeymap(term, { current: actions });
    expect(getHandler()(keyEvent({ key: "a" }))).toBe(true);
    expect(actions.paste).not.toHaveBeenCalled();
  });
});
