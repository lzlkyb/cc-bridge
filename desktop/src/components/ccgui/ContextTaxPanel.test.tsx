// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContextMeter } from "./ContextMeter";

/**
 * 测的是**真实接线**（ContextMeter + ContextTaxPanel），不是面板单独的壳。
 *
 * 这里锁的那条 bug 就长在接线上：面板监听的是**捕获阶段**的 `pointerdown`，
 * 它比开关按钮的 `click` 先跑。按钮若不被认作「自己人」，点它就是
 * 「pointerdown 先关掉 → click 再翻回打开」，用户看到的是**按钮关不掉面板**。
 * 只测面板本身发现不了 —— 面板那侧一切正常，错的是按钮没带 `data-cc-toggle`。
 *
 * 所以下面每个用例都要按真实顺序派发：`pointerdown` → `click`。
 * 只 `.click()` 会漏掉整条 bug。
 */
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement, qc: QueryClient;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(null);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  qc.clear();
  host.remove();
});

/** `sessionId: null` ⇒ 查询关掉，面板拿到 `tax: null`。这里测开关，不测数据。 */
async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <ContextMeter bar={null} tokens={0} sessionId={null} running={false} />
      </QueryClientProvider>,
    );
  });
}
function toggle(): HTMLButtonElement {
  const hit = [...host.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-haspopup") === "dialog",
  );
  if (!hit) throw new Error("找不到余量条开关按钮");
  return hit;
}
function panel(): HTMLElement | null {
  return host.querySelector('[role="dialog"]');
}
/** 真实浏览器里点一下的顺序。 */
async function realClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    (el as HTMLElement).click();
  });
}

it("点开关按钮能开、也能关（捕获阶段 pointerdown 不许把它当外点）", async () => {
  await mount();
  expect(panel()).toBeNull();
  await realClick(toggle());
  expect(panel()).not.toBeNull();
  await realClick(toggle());
  expect(panel()).toBeNull();
});

it("点面板里面不关", async () => {
  await mount();
  await realClick(toggle());
  const title = [...panel()!.querySelectorAll("*")].find((e) => e.textContent === "上下文构成");
  await act(async () => {
    title!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(panel()).not.toBeNull();
});

it("点外面关", async () => {
  await mount();
  await realClick(toggle());
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(panel()).toBeNull();
});

it("Esc 关", async () => {
  await mount();
  await realClick(toggle());
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(panel()).toBeNull();
});
