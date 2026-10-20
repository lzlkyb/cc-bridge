import { describe, expect, it } from "vitest";
import { connectionSessions, focusedTerminalSession } from "./terminalWorkspace";
import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";
import type { SshConnection } from "./types";

const conn = { id: "host-a" } as SshConnection;
const primary = { tabId: "a", sessionId: "session-a", conn, closedReason: null } as SshSessionRef;
const secondary = { ...primary, tabId: "b", sessionId: "session-b", splitOnly: true };
const other = { ...primary, tabId: "c", sessionId: "session-c", conn: { ...conn, id: "host-c" } };
const split = { secTabId: "b", ratio: 58, dir: "h" as const };

describe("shared terminal toolbar target", () => {
  it("选中副格时对副格操作；未选中时使用主格", () => {
    expect(focusedTerminalSession([primary, secondary], primary.sessionId, split, "b")).toBe(secondary);
    expect(focusedTerminalSession([primary, secondary], primary.sessionId, split, null)).toBe(primary);
  });
  it("关闭分屏、移除副格、切换宿主后都不再使用隐藏的副格", () => {
    expect(focusedTerminalSession([primary, secondary], primary.sessionId, null, "b")).toBe(primary);
    expect(focusedTerminalSession([primary], primary.sessionId, split, "b")).toBe(primary);
    expect(focusedTerminalSession([primary, secondary, other], other.sessionId, null, "b")).toBe(other);
    expect(focusedTerminalSession([primary], null, split, "b")).toBeNull();
  });
  it("断开的副格仍可成为只读操作目标，不默默粘贴到主格", () => {
    const closed = { ...secondary, closedReason: "disconnected" };
    expect(focusedTerminalSession([primary, closed], primary.sessionId, split, "b")).toBe(closed);
  });
});

describe("connection list session summary", () => {
  it("先前断开的标签不会遮住后续活会话，优先当前活会话", () => {
    const closed = { ...primary, closedReason: "disconnected" };
    const next = { ...primary, tabId: "next", sessionId: "next-session" };
    expect(connectionSessions([closed, secondary, next], conn.id, next.sessionId)).toEqual({ session: next, liveCount: 2, active: true });
    expect(connectionSessions([closed, secondary], conn.id, null).session).toBe(closed);
    expect(connectionSessions([secondary], conn.id, null).session).toBeUndefined();
  });
  it("断开标签保持选中，但在线计数只包括活会话", () => {
    const closed = { ...primary, closedReason: "restored" };
    expect(connectionSessions([closed], conn.id, primary.sessionId)).toEqual({ session: closed, liveCount: 0, active: true });
    expect(connectionSessions([], conn.id, null)).toEqual({ session: undefined, liveCount: 0, active: false });
  });
});
