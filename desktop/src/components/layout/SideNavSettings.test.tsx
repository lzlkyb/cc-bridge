// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SideNavSettings } from "./SideNavSettings";
import { SETTINGS_CATEGORIES } from "../../lib/settingsCategories";

vi.mock("../ui/Modal", () => ({ Modal: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement, now: number;
const select = vi.fn();
function Harness({ initial = "set-app", collapsed = false }) {
  const [activeId, setActiveId] = useState(initial);
  return <>
    <SideNavSettings sections={SETTINGS_CATEGORIES} activeId={activeId} collapsed={collapsed}
      onSelect={id => { select(id); setActiveId(id); }} onBack={() => {}} />
    <main aria-label="设置内容">内容区</main>
  </>;
}
beforeEach(() => {
  now = 0; select.mockClear();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("scrollIntoView", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(initial = "set-app", collapsed = false) {
  await act(async () => root.render(<Harness initial={initial} collapsed={collapsed} />));
}
function nav() { return host.querySelector<HTMLElement>('nav[aria-label="设置目录"]')!; }
async function wheel(deltaY: number, options: WheelEventInit = {}, target = nav()) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ...options });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

describe("设置目录滚轮切换", () => {
  it("向下切下一项、向上切上一项，并更新选中菜单", async () => {
    await render(); await wheel(100);
    expect(select).toHaveBeenLastCalledWith("set-terminal");
    expect(nav().querySelector('[aria-current="page"]')?.textContent).toContain("终端");
    now += 400; await wheel(-100);
    expect(select).toHaveBeenLastCalledWith("set-app");
  });

  it("按新目录顺序切换所有分类，到首尾不循环", async () => {
    await render(); await wheel(-100);
    expect(select).not.toHaveBeenCalled();
    for (const section of SETTINGS_CATEGORIES.slice(1)) {
      now += 400; await wheel(100);
      expect(select).toHaveBeenLastCalledWith(section.id);
    }
    now += 400; await wheel(100);
    expect(select).toHaveBeenCalledTimes(SETTINGS_CATEGORIES.length - 1);
  });

  it("同一段连续滚轮不会立刻连跳，冷却后可继续切换", async () => {
    await render(); await wheel(100);
    now = 50; await wheel(100); now = 300; await wheel(100);
    expect(select).toHaveBeenCalledTimes(1);
    now = 350; await wheel(100);
    expect(select).toHaveBeenLastCalledWith("set-network");
  });

  it("小幅输入累计、换方向或停顿后丢弃旧余额", async () => {
    await render("set-terminal");
    await wheel(40); now = 20; await wheel(-30);
    expect(select).not.toHaveBeenCalled();
    now = 250; await wheel(-40);
    expect(select).not.toHaveBeenCalled();
    now = 270; await wheel(-20);
    expect(select).toHaveBeenCalledExactlyOnceWith("set-app");
  });

  it("兼容按行和按页报告的滚轮单位", async () => {
    await render(); await wheel(4, { deltaMode: 1 });
    expect(select).toHaveBeenLastCalledWith("set-terminal");
    now += 400; await wheel(1, { deltaMode: 2 });
    expect(select).toHaveBeenLastCalledWith("set-network");
  });

  it("目录溢出时优先原生滚动，只在对应边缘切换", async () => {
    await render("set-terminal");
    Object.defineProperties(nav(), { clientHeight: { value: 200 }, scrollHeight: { value: 600 } });
    const event = await wheel(100);
    expect(select).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
    nav().scrollTop = 400; await wheel(-100);
    expect(select).not.toHaveBeenCalled();
    await wheel(100);
    expect(select).toHaveBeenLastCalledWith("set-network");
    now += 400; nav().scrollTop = 0; await wheel(-100);
    expect(select).toHaveBeenLastCalledWith("set-terminal");
  });

  it("搜索结果保持普通滚动，不切换分类", async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "字号");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(nav().textContent).toContain("个设置结果");
    await wheel(100);
    expect(select).not.toHaveBeenCalled();
  });

  it("右侧内容、横向输入和修饰键滚轮均不切换分类", async () => {
    await render();
    await wheel(100, {}, host.querySelector("main")!);
    for (const options of [{ deltaX: 100 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      await wheel(100, options);
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("侧栏收起为图标时仍支持滚轮切换", async () => {
    await render("set-app", true); await wheel(100);
    expect(select).toHaveBeenCalledExactlyOnceWith("set-terminal");
  });
});
