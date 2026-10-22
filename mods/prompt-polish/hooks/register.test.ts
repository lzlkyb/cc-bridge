// 离线单测：验证 register() 挂了哪些事件、登记了哪两个命令。
// 跑法：claude plugin test ./mods/prompt-polish   （不需要网络、不需要模型）
// 用 throw 而不是 expect 的链式 API，避免依赖 kit 的断言方言。
import { test } from "claude-code/testing";
import { register } from "./register.js";

test("registers expected hooks and commands", async () => {
  const patterns: string[] = [];
  const commands: string[] = [];
  const hooks: Record<string, Array<(...args: unknown[]) => unknown>> = {};

  // 假 on：记录事件名，并留住最后一个参数（handler）
  const on = (pattern: string, ...rest: unknown[]) => {
    patterns.push(pattern);
    const hook = rest[rest.length - 1] as (...args: unknown[]) => unknown;
    (hooks[pattern] ??= []).push(hook);
  };

  // 假 $：register 在 session.start 里只会碰 command.register
  const fakeDollar = {
    command: {
      register: async (def: { name: string }) => {
        commands.push(def.name);
      },
    },
  };

  register(on as never);

  for (const hook of hooks["session.start"] ?? []) {
    await hook(fakeDollar, {}, async (e: unknown) => e);
  }

  const required = ["prompt.edit", "prompt.change", "session.start", "command.run", "ui.render"];
  for (const name of required) {
    if (!patterns.includes(name)) throw new Error("未订阅事件：" + name);
  }

  if (commands.join(",") !== "polish,polish-probe") {
    throw new Error("命令登记不对：" + JSON.stringify(commands));
  }
});
