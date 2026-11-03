// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 毛玻璃适配的接线契约（方案 B，见 docs/关于页毛玻璃高饱和元素适配方案-2026-11-03.md）
   三处底色写在 React 内联 style 上，glass 主题只能靠 CSS 变量穿透（内联优先级高于任何
   选择器）。这里锁住「变量 + 原值兜底」这个形态：
     · 少了兜底 ⇒ classic 主题拿不到颜色（整块变透明）；
     · 少了变量 ⇒ glass 主题覆盖不上（又变回实底贴纸）。
   两者都不会让 tsc/eslint 报错，只能靠这条测试兜。 */
vi.mock("../../contexts/UpdateContext", () => ({
  useUpdate: () => ({
    status: "idle", update: null, progress: 0, progressIndeterminate: false, bytesPerSec: 0,
    downloadedBytes: 0, autoRestartIn: 0, error: null, errorCode: null,
    manualCheckForUpdate: vi.fn(), openUpdateNotes: vi.fn(),
  }),
}));
vi.mock("../ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./SponsorCard", () => ({ SponsorCard: () => null }));
vi.mock("./AboutInfoModal", () => ({ AboutInfoModal: () => null }));

const { AboutGroup } = await import("./AboutGroup");
const { ChangelogView } = await import("./ChangelogView");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** 内联 style 里的某个声明必须同时带变量与原值兜底（比较前统一去空白，jsdom 会压缩声明）。 */
function expectVarFallback(el: Element | null, variable: string, fallback: string) {
  expect(el, `找不到元素：${variable}`).not.toBeNull();
  const style = (el as HTMLElement).getAttribute("style") ?? "";
  const flat = (s: string) => s.replace(/\s+/g, "");
  expect(style, `${variable} 必须出现在内联 style 里`).toContain(variable);
  expect(flat(style), `var(${variable}) 必须带兜底 ${fallback}`)
    .toContain(flat(`var(${variable},${fallback})`));
}

describe("关于页玻璃适配：版本胶囊", () => {
  it("底色与投影都走 CSS 变量回退（glass 覆盖 + classic 兜底）", async () => {
    await act(async () => root.render(<AboutGroup />));
    const chip = host.querySelector(".version-chip");
    expectVarFallback(chip, "--version-chip-bg", "var(--version-gradient)");
    expectVarFallback(chip, "--version-chip-shadow", "0 2px 6px var(--version-shadow)");
  });
});

describe("关于页玻璃适配：更新历史", () => {
  it("版本条 / 版本胶囊 / 最新标记各带变量回退", async () => {
    await act(async () => root.render(<ChangelogView />));
    expectVarFallback(host.querySelector(".cl-version-bar"), "--cl-bar-bg", "var(--color-accent)");
    expectVarFallback(host.querySelector(".cl-version-capsule"), "--cl-capsule-bg", "var(--color-primary)");
    // 「最新」必须独立一档：与版本胶囊共用变量时，glass 下同色会一起消失
    const latest = host.querySelector(".cl-latest-tag");
    expectVarFallback(latest, "--cl-latest-bg", "var(--color-primary)");
    expect(latest?.getAttribute("style")).not.toContain("--cl-capsule-bg");
  });
});
