// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* ── 骨架屏与真实 UI 对齐（方案 B + C，见 design/骨架屏对齐-设计稿-2026-11-06.html）──
   这套断言测不了 DOM：首帧骨架在 JS bundle 加载前就画出来了，React 侧骨架的形状
   又完全由真实类名（.s-row / .usage-conv-row / .usage-kpi）决定，jsdom 既不做布局
   也不加载 CSS。所以退一步读源文本，锁住「谁必须跟谁一致」这几条结构事实。

   要防的回归形态非常具体：
   ① 首帧骨架又画回「顶栏 + 横向 Tab 条」——2026-10-14 改侧栏导航后它过期了一个月；
   ② `.skeleton` 又变回 opacity 呼吸（与首帧的扫光两套语言）；
   ③ 某处骨架退回硬编码尺寸 / 一整块灰块，不再挂真实类名；
   ④ `.vh-skel` / `.skel` 这类第四、第五套实现复活。

   为什么不用 `?raw` 导入：vitest 的 CSS 处理会把 `*.css?raw` 替换成空模块
   （实测 length=0）。所以只能 node:fs + node 环境，类型声明见 src/vite-env.d.ts。 */

/** src/ 的 URL（vitest 版本的基址可能是 src/ 本身或测试文件目录，两种都试）。 */
const SRC = (() => {
  for (const rel of ["./appearance.css", "../appearance.css"]) {
    const u = new URL(rel, import.meta.url);
    if (existsSync(u)) return new URL("./", u);
  }
  throw new Error(`找不到 src/appearance.css（import.meta.url=${import.meta.url}）`);
})();
/** desktop/ 的 URL（index.html 在 src 的上一层）。 */
const DESKTOP = new URL("../", SRC);

const readSrc = (rel: string) => readFileSync(new URL(rel, SRC), "utf8");
const readHtml = () => readFileSync(new URL("index.html", DESKTOP), "utf8");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const HTML = readHtml();
const INDEX_CSS = readSrc("index.css");
const TAB_FALLBACK = readSrc("components/layout/TabFallback.tsx");
const RECENT = readSrc("components/tabs/filecontrol/RecentAiChanges.tsx");
const CONV = readSrc("components/tabs/settings/ConversationUsageSection.tsx");
const TOKEN = readSrc("components/tabs/settings/TokenUsageGroup.tsx");
const LOG_TAB = readSrc("components/tabs/LogTab.tsx");
const DIFF_MODAL = readSrc("components/tabs/LogDiffModal.tsx");
const VH_MODAL = readSrc("components/backup/VersionHistoryModal.tsx");

describe("首帧骨架（desktop/index.html）", () => {
  it("画的是侧栏布局，不再有横向 Tab 条", () => {
    expect(HTML).toContain('class="boot-side"');
    expect(count(HTML, 'class="boot-item')).toBe(5);
    // 2026-10-14 之前的横向导航条，任何一个残留都说明又画回了旧布局。
    expect(HTML).not.toContain("boot-tabs");
    expect(HTML).not.toContain("boot-tab ");
  });

  it("尺寸取真实布局：侧栏 200 / 品牌区 52 / 顶栏 52 / logo 28", () => {
    expect(HTML).toContain("width: 200px");
    expect(count(HTML, "height: 52px")).toBeGreaterThanOrEqual(2);
    expect(HTML).toContain("width: 28px");
    expect(HTML).toContain("border-radius: 7px");
  });

  it("渲染前就同步材质，否则玻璃用户先看到实色白壳", () => {
    expect(HTML).toContain('document.documentElement.dataset.uiStyle');
    // 键名必须与 lib/appearance.ts 一致，否则永远读不到，默认值又会「歪打正着」。
    expect(HTML).toContain("cc-bridge.ui-style");
    expect(HTML).toContain('[data-ui-style="glass"]');
    // 玻璃底是三团柔光，不是纯色。
    expect(count(HTML, "radial-gradient")).toBeGreaterThanOrEqual(6);
  });

  it("玻璃态下侧栏与顶栏透明（与 appearance.css 同做法）", () => {
    expect(HTML).toContain(":root[data-ui-style=\"glass\"] .boot-side");
    expect(HTML).toContain("background: transparent");
  });

  it("深色卡片色跟真实 token 走，不是偏暖的 #1e1e21", () => {
    expect(HTML).toContain("#191f2c");
    expect(HTML).not.toContain("#1e1e21");
  });

  it("扫光挂在 ::after 上（合成属性），不用 background-position", () => {
    expect(HTML).toContain(".sk.live::after");
    expect(HTML).toContain("translateX(-100%)");
    // 只断言「没有这条声明」，注释里提到的对比不算。
    expect(HTML).not.toContain("background-position:");
  });
});

/* ── 内容区几何：照抄连接页的 12 列 bento ──
   这一组是 2026-11-06 补的。此前首帧内容区画的是「三张竖着排的全宽白卡」，而真实
   连接页是 `status-card 占左侧 1/3 跨两行 + 四张指标卡 + 两张面板 + 一张接入向导`
   （index.css:518-538）。**卡片数量对不上**这种错，只核尺寸是核不出来的 —— 当时
   那套测试全绿，界面却是错的。 */
const strip = (s: string) => s.replace(/\s+/g, "");

describe("首帧内容区 = 连接页 bento 网格", () => {
  it("12 列网格，列跨度与 index.css 的子选择器逐条同源", () => {
    expect(strip(HTML)).toContain("grid-template-columns:repeat(12,minmax(0,1fr))");
    // status-card 1/5 跨两行，四张指标卡 5/7·7/9·9/11·11/13，两张面板 5/9·9/13。
    for (const span of ["1/5", "5/7", "7/9", "9/11", "11/13", "5/9", "9/13"]) {
      expect(strip(HTML)).toContain(`grid-column:${span}`);
      expect(strip(INDEX_CSS)).toContain(`grid-column:${span}`);
    }
    expect(strip(HTML)).toContain("grid-row:1/3");
    expect(strip(INDEX_CSS)).toContain("grid-row:1/3");
  });

  it("状态主卡是靛蓝渐变，不是白卡", () => {
    // 首屏最抢眼的一块。画成白的，React 挂载那一下就是整块「白 → 紫」跳变。
    expect(HTML).toContain("--sk-primary: #4f46e5");
    expect(HTML).toContain("linear-gradient(160deg, var(--sk-primary), var(--sk-primary-dim))");
    // 深色下 --primary 换 #6366F1（index.css:197 附近），不能沿用浅色那支。
    expect(HTML).toContain("--sk-primary: #6366f1");
    // 卡内的条要换成白膜，浅灰叠在靛蓝上等于没画。
    expect(HTML).toContain(".boot-status .sk");
  });

  it("行高取实测值：指标卡 149、下方面板 231、向导卡在视口外被裁", () => {
    expect(HTML).toContain("min-height: 149px");
    expect(HTML).toContain("min-height: 231px");
    expect(HTML).toContain('class="boot-guide"');
    expect(HTML).toContain('class="boot-form"');
  });

  it("有全局 border-box —— 少了它每张卡都会长出一圈 padding", () => {
    // 真实界面靠 Tailwind preflight 设这个；首帧样式在它之外。实测漏了它时
    // 指标卡 149→175、向导卡 460→490，整片网格比真实首屏矮/高错位。
    // 用正则而不是 includes：注释里那几个字不算数（把声明注释掉也要能测出来）。
    expect(HTML).toMatch(/\n\s+box-sizing: border-box;/);
  });

  it(".sk 基类排在按需覆盖圆角/flex 的类之前（同特异性看顺序）", () => {
    // 放在最后曾把 .sk-node 的圆角盖成 5px（圆点变方块）、把 flex:1 的按钮压成 0 宽。
    const base = HTML.indexOf("\n      .sk {");
    expect(base).toBeGreaterThanOrEqual(0);
    for (const later of [".sk-node {", ".sk-chip {", ".sk-pill-btn {"]) {
      expect(HTML.indexOf(later)).toBeGreaterThan(base);
    }
  });
});

describe(".skeleton 与首帧同源", () => {
  it("是扫光而不是整块 opacity 呼吸", () => {
    expect(INDEX_CSS).toContain(".skeleton::after");
    expect(INDEX_CSS).toContain("@keyframes skeleton-sweep");
    expect(INDEX_CSS).not.toContain("skeleton-shimmer");
  });

  it("周期与首帧一致（1.3s），改一处必须同步另一处", () => {
    expect(INDEX_CSS).toContain("skeleton-sweep 1.3s");
    expect(HTML).toContain("boot-sweep 1.3s");
  });

  it("窗口隐藏时暂停的是伪元素上的动画", () => {
    expect(INDEX_CSS).toContain(":root[data-app-hidden] .skeleton::after");
  });

  it("第四、第五套实现已清除（.vh-skel / 日志页的 .skel 死类）", () => {
    expect(INDEX_CSS).not.toContain("vh-skel-shimmer");
    expect(VH_MODAL).not.toContain('className="vh-skel');
    expect(LOG_TAB).not.toContain('className="skel');
  });
});

describe("TabFallback 按页分档", () => {
  it("四个档位都在，且 App 按页传对了", () => {
    for (const kind of ["cards", "table", "split", "blank"]) {
      expect(TAB_FALLBACK).toContain(`"${kind}"`);
    }
    const app = readSrc("App.tsx");
    expect(app).toContain('kind="cards"');
    expect(app).toContain('kind="table"');
    expect(app).toContain('kind="split"');
    expect(app).toContain('kind="blank"');
  });

  it("表格骨架列宽照抄日志页真实表头", () => {
    // 74 时间 / 124 操作 / 1fr 参数摘要 / 100 来源 / 64 耗时 / 64 状态 / 36 详情
    expect(TAB_FALLBACK).toContain("74px 124px minmax(0,1fr) 100px 64px 64px 36px");
    for (const w of ["w-[74px]", "w-[124px]", "w-[100px]", "w-[64px]"]) {
      expect(LOG_TAB).toContain(w);
    }
  });

  it("blank 档不画任何块（终端配色有 6 套，画什么都可能在某个配色下错）", () => {
    const i = TAB_FALLBACK.indexOf('if (kind === "blank")');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(TAB_FALLBACK.slice(i, i + 60)).toContain("return null");
  });
});

describe("内联骨架挂真实类名（B 方案的核心）", () => {
  it("最近 AI 改动用 .s-row 行结构", () => {
    expect(RECENT).toContain('className="s-row"');
    expect(RECENT).toContain('className="title-chip"');
    expect(RECENT).not.toContain('className="h-4 w-3/4"');
  });

  it("对话消耗用 .usage-conv-row，且表头在骨架期也渲染", () => {
    expect(CONV).toContain('className="usage-conv-row"');
    expect(CONV).toContain('className="usage-conv-head"');
    expect(CONV).not.toContain("h-24 w-full");
  });

  it("Token 用量 KPI 骨架四行齐全（label/value/delta/spark）", () => {
    const i = TOKEN.indexOf("function KpiSkeleton");
    expect(i).toBeGreaterThanOrEqual(0);
    const body = TOKEN.slice(i, TOKEN.indexOf("</>", i));
    expect(count(body, "<Skeleton")).toBe(4);
  });

  it("Diff 弹窗骨架有行号列", () => {
    expect(DIFF_MODAL).toContain("flex gap-2");
    expect(DIFF_MODAL).toContain("w-8 shrink-0");
  });
});

describe("C 方案：延迟门接在骨架显示条件上", () => {
  it("四处内联骨架都经 useDelayedLoading", () => {
    for (const src of [RECENT, CONV, TOKEN, DIFF_MODAL, LOG_TAB]) {
      expect(src).toContain("useDelayedLoading(");
    }
  });

  it("Tab chunk 有闲时预取（骨架只是兜底，能不出就不出）", () => {
    const app = readSrc("App.tsx");
    expect(app).toContain("importSecurity()");
    expect(app).toContain("importCcGui()");
    expect(app).toContain("1500");
  });
});
