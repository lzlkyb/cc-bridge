import { describe, expect, it } from "vitest";
import { isSendKey, type SendKey } from "./ccSendKey";

const press = (key: string, mods: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {}) => ({
  key,
  shiftKey: Boolean(mods.shift),
  ctrlKey: Boolean(mods.ctrl),
  metaKey: Boolean(mods.meta),
});

describe("isSendKey", () => {
  /**
   * 🔴 这一组是本模块存在的理由：`Shift+Enter` 在**两档**下都必须是换行。
   * 写反一次，用户每敲一个换行就发出一条半截的消息 —— 而它看起来像「软件抽风」，
   * 报错日志里什么都没有。
   */
  it("Shift+Enter 在两档下都不发送（它永远是换行）", () => {
    const modes: SendKey[] = ["enter", "ctrlEnter"];
    for (const mode of modes) {
      expect(isSendKey(mode, press("Enter", { shift: true }))).toBe(false);
      expect(isSendKey(mode, press("Enter", { shift: true, ctrl: true }))).toBe(false);
    }
  });

  it("默认档：裸 Enter 发送", () => {
    expect(isSendKey("enter", press("Enter"))).toBe(true);
  });

  it("默认档也认 Ctrl/⌘+Enter（兼容从旧行为改过来的人）", () => {
    expect(isSendKey("enter", press("Enter", { ctrl: true }))).toBe(true);
    expect(isSendKey("enter", press("Enter", { meta: true }))).toBe(true);
  });

  it("旧档：裸 Enter 只换行，Ctrl/⌘+Enter 才发送", () => {
    expect(isSendKey("ctrlEnter", press("Enter"))).toBe(false);
    expect(isSendKey("ctrlEnter", press("Enter", { ctrl: true }))).toBe(true);
    expect(isSendKey("ctrlEnter", press("Enter", { meta: true }))).toBe(true);
  });

  it("其它键一律不归它管（交给 @引用 / 斜杠面板 / 输入法）", () => {
    expect(isSendKey("enter", press("a"))).toBe(false);
    expect(isSendKey("enter", press("Escape"))).toBe(false);
    expect(isSendKey("ctrlEnter", press("NumpadEnter", { ctrl: true }))).toBe(false);
  });
});
