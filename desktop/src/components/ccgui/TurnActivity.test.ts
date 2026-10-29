import { describe, expect, it } from "vitest";
import type { CcMessage } from "../../lib/ccGuiTypes";
import { turnActivity } from "./TurnActivity";

const user: CcMessage = { kind: "user", id: "u", text: "检查问题", at: "" };
const reply: CcMessage = { kind: "assistant", id: "a", text: "结果", at: "" };

describe("本轮等待提示", () => {
  it("发送和等待阶段区分本地提交，不假称模型正在思考", () => {
    expect(turnActivity([], true, true)).toBe("正在发送消息");
    expect(turnActivity([user], true, false)).toBe("等待响应");
  });
  it("有本轮内容或停止后移除等待提示", () => {
    expect(turnActivity([user, reply], true, false)).toBe("本轮进行中");
    expect(turnActivity([user], false, false)).toBeNull();
    expect(turnActivity([user, reply, user], true, false)).toBe("等待响应");
  });
  it("新一轮尚未收到用户消息时，不把历史回复当作当前进展", () => {
    expect(turnActivity([user, reply], true, true, 2)).toBe("正在发送消息");
    expect(turnActivity([user, reply, user], true, false, 2)).toBe("等待响应");
    expect(turnActivity([user, reply, user, reply], true, false, 2)).toBe("本轮进行中");
  });
});
