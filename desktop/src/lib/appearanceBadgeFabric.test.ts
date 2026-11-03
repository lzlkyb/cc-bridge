// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* ── 徽章面料单一真源（方案 D，见 docs/版本徽章毛玻璃统一方案-2026-11-03.md）──
   这套断言测不了 DOM：三处版本号的「统一」是 CSS 级联的结果，jsdom 既不解析
   appearance.css，`getComputedStyle` 也只会给出空串。所以退一步读样式源文本，
   锁住「几处必须引用同一个变量」—— 一旦有人把某处改回字面投影串，这里就红。
   要防的回归形态很具体：三处的 box-shadow 又变回 4 段 / 3 段 / 0 段。

   为什么不用 `import "../appearance.css?raw"`：vitest 的 CSS 处理会把它替换成
   空模块（实测 length 为 0），所以只能走 node:fs + node 环境。类型声明见
   src/vite-env.d.ts（只补了 readFileSync / existsSync 两个）。 */

/** src/ 目录的 URL。vitest 在不同版本里把 import.meta.url 指向 src/ 本身或测试
    文件所在目录，两种基址都试一遍，避免因为升级 vitest 就整组失败。 */
const SRC = (() => {
  for (const rel of ["./appearance.css", "../appearance.css"]) {
    const u = new URL(rel, import.meta.url);
    if (existsSync(u)) return new URL("./", u);
  }
  throw new Error(`找不到 src/appearance.css（import.meta.url=${import.meta.url}）`);
})();

const readSrc = (rel: string) => readFileSync(new URL(rel, SRC), "utf8");
const CSS = readSrc("appearance.css");
const count = (needle: string) => CSS.split(needle).length - 1;

/** 取某个选择器紧跟的那对花括号里的内容（够用：这些规则都不嵌套）。 */
function ruleBody(selector: string): string {
  const i = CSS.indexOf(selector);
  expect(i, `appearance.css 里找不到选择器：${selector}`).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf("{", i);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}

/** 同一选择器常命中多条规则（.version-chip 既有字色又有圆角），全部取出。 */
function ruleBodies(selector: string): string[] {
  const out: string[] = [];
  for (let from = 0; ; ) {
    const i = CSS.indexOf(selector, from);
    if (i < 0) return out;
    const open = CSS.indexOf("{", i);
    out.push(CSS.slice(open + 1, CSS.indexOf("}", open)));
    from = i + selector.length;
  }
}

describe("版本徽章面料：单一真源", () => {
  it("版本号三处（侧栏待命 / 关于页 chip / 更新历史胶囊）引用同一档面料", () => {
    // 侧栏 idle / checking / uptodate
    const idle = ruleBody('html[data-ui-style="glass"] .update-slot :is(.header-badge-idle,');
    expect(idle).toContain("--badge-depth: var(--gb-fabric-edge);");
    // 关于页 chip：底色写在组件内联 style 上，CSS 只能注入变量值
    expect(CSS).toContain("--version-chip-shadow: var(--gb-fabric-edge);");
    // 更新历史胶囊原本 box-shadow 是 none，必须补同一档
    expect(ruleBody('html[data-ui-style="glass"] .cl-version-capsule {')).toContain(
      "box-shadow: var(--gb-fabric-edge);",
    );
    // 染色也得同源，否则「同面料不同色」并排还是两块不一样
    expect(CSS).toContain("--version-chip-bg: var(--gb-fill-neutral);");
    expect(CSS).toContain("--cl-capsule-bg: var(--gb-fill-neutral);");
  });

  it("深色段不再重复定义版本号变量（重复即下一次分叉的起点）", () => {
    for (const v of ["--version-chip-bg:", "--version-chip-shadow:", "--cl-capsule-bg:", "--cl-latest-bg:"]) {
      expect(count(v), `${v} 只该出现在浅色段，深色由 --gb-* 自带`).toBe(1);
    }
  });

  it("状态与版本号仍可区分：强调档走另一组变量", () => {
    const accent = ruleBody('html[data-ui-style="glass"] .update-slot :is(.header-badge-update,');
    expect(accent).toContain("background: var(--gb-fill-accent);");
    expect(accent).toContain("color: var(--gb-ink-accent);");
    expect(accent).not.toContain("--gb-fill-neutral");
  });

  it("圆角与侧栏槽位一致（1px 断层就是这么来的）", () => {
    const badge = ruleBody('html[data-ui-style="glass"] .update-slot .header-badge {');
    // .version-chip 有两条规则（字色 / 圆角），取带 border-radius 的那条
    const chip = ruleBodies('html[data-ui-style="glass"] :is(.version-chip, .cl-version-capsule) {')
      .find((b) => b.includes("border-radius"));
    const pick = (s: string | undefined) => s?.match(/border-radius:\s*([^;]+);/)?.[1].trim();
    expect(pick(badge)).toBe("7px");
    expect(pick(chip)).toBe(pick(badge));
  });

  it("classic 兜底还在：弹窗品牌块的投影必须带原值", () => {
    const modal = readSrc("components/tabs/AboutInfoModal.tsx");
    expect(modal).toContain("var(--brand-slab-shadow, 0 3px 10px var(--version-shadow))");
    expect(CSS).toContain("--brand-slab-shadow: var(--gb-fabric-solid);");
  });

  it("死类 .version-badge 不再回来", () => {
    // 这个类住在 index.css（classic 基础样式），不在 appearance.css
    expect(readSrc("index.css")).not.toMatch(/^\s*\.version-badge\s*\{/m);
  });
});
