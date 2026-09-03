import { describe, it, expect } from "vitest";
import { sshOutputEvent } from "./terminalEvents";

describe("sshOutputEvent", () => {
  /**
   * 🔴 这条断言里的字面量与 Rust 端
   * `output_event_name_is_per_session_and_charset_safe` 里的完全一致。
   * 跨语言约定只能靠两边各钉一条来守，改一边忘了另一边就会红。
   */
  it("与 Rust 端逐字一致", () => {
    expect(sshOutputEvent("3f2b1c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d")).toBe(
      "ssh_output_3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    );
  });

  it("只留字母数字与下划线", () => {
    const name = sshOutputEvent("aa-bb/cc:dd..ee");
    expect(name).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it("不同会话不能撞名（否则两个终端会收到彼此的输出）", () => {
    expect(sshOutputEvent("a-1")).not.toBe(sshOutputEvent("a-2"));
  });

  /**
   * 去分隔符不能造出碰撞：`a-b` 与 `ab` 剔掉非字母数字后都是 `ab`。
   * 实际 sessionId 是定长 uuid，不会出现这种对；这条只是把边界写明白，
   * 以免日后有人拿自造的短 id 来用。
   */
  it("已知局限：非 uuid 的自造 id 可能碰撞", () => {
    expect(sshOutputEvent("a-b")).toBe(sshOutputEvent("ab"));
  });
});
