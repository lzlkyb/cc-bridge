import { describe, it, expect } from "vitest";
import { appendRule, malformedCcRules, parseCcRules } from "./ccAutoApprove";

/**
 * 锁住 advisory 预检的边缘行为。这些函数不决定放不放行（那在后端），
 * 但「界面提不提示」会静默退化：正则被「简化」一下，`Read()` 不再被标出来，
 * 用户按一条永不生效的规则放心地人工点允许，没人会发现。
 */
describe("parseCcRules", () => {
  it("拆分、去空白、丢空行", () => {
    expect(parseCcRules(" Read(src/**) \n\n\tEdit(*)\n  \n")).toEqual(["Read(src/**)", "Edit(*)"]);
  });

  it("全空白 = 空表（= 全部人工审批）", () => {
    expect(parseCcRules("   \n\t\n")).toEqual([]);
  });
});

describe("malformedCcRules", () => {
  it("正常规则不报警", () => {
    expect(malformedCcRules(["Read(src/**)", "Bash(git status)", "Read"])).toEqual([]);
  });

  it("括号不成对报警", () => {
    expect(malformedCcRules(["Read(src/**"])).toEqual([{ line: 1, rule: "Read(src/**" }]);
    expect(malformedCcRules(["Read(src/**)", "Edit(src"])).toEqual([
      { line: 2, rule: "Edit(src" },
    ]);
  });

  it("空 glob 报警（`Read()` 匹配不了任何文件，写了等于没写）", () => {
    expect(malformedCcRules(["Read()"])).toEqual([{ line: 1, rule: "Read()" }]);
    expect(malformedCcRules(["Read(  )"])).toEqual([{ line: 1, rule: "Read(  )" }]);
  });

  it("命令里的嵌套括号不算毛病", () => {
    // Bash(echo (hi)) 括号成对，globset 也接受字面括号
    expect(malformedCcRules(["Bash(echo (hi))"])).toEqual([]);
  });

  it("行号按 1 起算且指向原始行", () => {
    const bad = malformedCcRules(["Read(*)", "ok", "Bash(git status"]);
    expect(bad).toEqual([{ line: 3, rule: "Bash(git status" }]);
  });
});

/**
 * 审批卡「以后都放行这类」的落库那一步。`changed === false` 时调用方只放行
 * 这一次、不再写配置 —— 判断错了会让用户连点两次看到两条一模一样的规则。
 */
describe("appendRule", () => {
  it("追加到末尾，不动已有顺序", () => {
    const { next, changed } = appendRule(["Read(src/**)", "Bash(git status)"], "Bash(cargo test)");
    expect(changed).toBe(true);
    // 规则表有序（先命中的先用），追加不能重排
    expect(next).toEqual(["Read(src/**)", "Bash(git status)", "Bash(cargo test)"]);
  });

  it("已存在同一条 ⇒ 不重复加、引用都不变", () => {
    const rules = ["Bash(git status)"];
    const { next, changed } = appendRule(rules, "Bash(git status)");
    expect(changed).toBe(false);
    expect(next).toBe(rules);
  });

  it("单条规则前后空白不影响判重", () => {
    const { changed } = appendRule(["Bash(git status)"], "  Bash(git status)  ");
    expect(changed).toBe(false);
  });

  it("空串不算规则", () => {
    const rules: string[] = [];
    expect(appendRule(rules, "   ")).toEqual({ next: rules, changed: false });
  });
});
