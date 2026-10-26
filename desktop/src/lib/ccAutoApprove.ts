/**
 * CC 审批自动放行规则的前端侧预处理（**advisory，不拦截**）。
 *
 * 匹配语义全在 Rust `cc_session::autoapprove`，前端不复制那份 globset 编译逻辑——
 * 两份实现必然 diverging，而 diverge 的方向永远是「界面说放了、后端没放」。
 * 这里只做两件后端不做的事：
 *   ① 文本 → 规则数组（拆分 / 去空白 / 丢空行，与后端 normalize 同口径）；
 *   ② 最常见的 typo 预检（括号不成对、空 glob），只提示、不阻止保存——
 *      后端忽略解析不了的规则是 fail-closed 的安全方向，前端无权替用户删。
 */

/** 拆分、去空白、丢空行。 */
export function parseCcRules(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 格式存疑的行（1 起行号 + 原文）。空数组 = 没看出问题。 */
export function malformedCcRules(rules: string[]): { line: number; rule: string }[] {
  const bad: { line: number; rule: string }[] = [];
  rules.forEach((rule, i) => {
    const open = (rule.match(/\(/g) ?? []).length;
    const close = (rule.match(/\)/g) ?? []).length;
    if (open !== close || (open === 1 && /\(\s*\)/.test(rule))) {
      bad.push({ line: i + 1, rule });
    }
  });
  return bad;
}

/**
 * 把一条新规则并进规则表。已存在同一条时**原样返回**（引用都不变）。
 *
 * 用于审批卡的「以后都放行这类」：`changed === false` 表示这条规则本来就有，
 * 调用方据此只放行这一次、不再写一遍配置。写一遍本身无害，但会多一次
 * `save_config` 与一次 `status` 失效 —— 而用户看不出任何区别。
 *
 * 不排序、不去重别的条目：规则表是**有序**的（先命中的先用），
 * 动顺序等于改动别人的匹配优先级。
 */
export function appendRule(rules: string[], rule: string): { next: string[]; changed: boolean } {
  const trimmed = rule.trim();
  if (!trimmed || rules.includes(trimmed)) return { next: rules, changed: false };
  return { next: [...rules, trimmed], changed: true };
}
