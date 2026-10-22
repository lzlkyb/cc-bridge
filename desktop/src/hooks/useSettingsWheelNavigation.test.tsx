// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsWheelNavigation } from "./useSettingsWheelNavigation";
import { SETTINGS_CATEGORIES } from "../lib/settingsCategories";
import { ViewActivityContext } from "../lib/viewActivity";
import { attachPageInertia } from "../lib/pageInertia";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, now: number;
const select = vi.fn();
function Harness({ initial = "set-app" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(initial);
  useSettingsWheelNavigation(ref, SETTINGS_CATEGORIES, current, id => { select(id); setCurrent(id); });
  return <div ref={ref}>{SETTINGS_CATEGORIES.map(section => <div key={section.id} hidden={section.id !== current} data-category={section.id} className="settings-category-panel" style={{overflowY:"auto"}}>
    <span>内容</span><textarea /><input /><select /><div role="listbox" /><div className="xterm" />
    <div data-nested style={{overflowY:"auto"}} />
  </div>)}</div>;
}
beforeEach(() => {
  now = 0; select.mockClear();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(initial = "set-app", active = true) {
  await act(async () => root.render(<ViewActivityContext.Provider value={active}><Harness initial={initial} /></ViewActivityContext.Provider>));
  for (const panel of host.querySelectorAll(".settings-category-panel")) size(panel, 200, 600);
}
function size(el: Element, height: number, scrollHeight: number) {
  Object.defineProperties(el, {clientHeight:{value:height,configurable:true},scrollHeight:{value:scrollHeight,configurable:true}});
}
function panel() { return host.querySelector<HTMLElement>('.settings-category-panel:not([hidden])')!; }
async function wheel(deltaY: number, target: Element = panel(), options: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", {bubbles:true,cancelable:true,deltaY,...options});
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

describe("右侧设置内容的滚轮衔接", () => {
  it("先放行内容滚动，到底部后才切换下一分类并阻止惯性穿透", async () => {
    await render();
    expect((await wheel(100)).defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();
    panel().scrollTop = 400;
    expect((await wheel(100)).defaultPrevented).toBe(true);
    expect(select).toHaveBeenCalledExactlyOnceWith("set-terminal");
  });
  it("上滚先滚内容，回到顶部后再切换上一分类", async () => {
    await render("set-terminal"); panel().scrollTop = 120; await wheel(-100);
    expect(select).not.toHaveBeenCalled();
    panel().scrollTop = 0; await wheel(-100);
    expect(select).toHaveBeenCalledExactlyOnceWith("set-app");
  });
  it("无溢出内容也能直接衔接分类，首尾不循环", async () => {
    await render(); size(panel(), 200, 200); await wheel(-100);
    expect(select).not.toHaveBeenCalled();
    await wheel(100); expect(select).toHaveBeenLastCalledWith("set-terminal");
    for (const section of SETTINGS_CATEGORIES.slice(2)) {
      now += 400; panel().scrollTop = 400; await wheel(100);
      expect(select).toHaveBeenLastCalledWith(section.id);
    }
    now += 400; panel().scrollTop = 400; await wheel(100);
    expect(select).toHaveBeenCalledTimes(SETTINGS_CATEGORIES.length - 1);
  });
  it("不连跳，并保留返回分类时的原滚动位置", async () => {
    await render(); const app = panel(); app.scrollTop = 400; await wheel(100);
    panel().scrollTop = 400; now = 50; await wheel(100);
    expect(select).toHaveBeenCalledTimes(1);
    now = 400; panel().scrollTop = 0; await wheel(-100);
    expect(panel()).toBe(app); expect(app.scrollTop).toBe(400);
  });
  it("小幅输入累计，停顿或方向改变后丢弃旧余额", async () => {
    await render("set-terminal"); await wheel(-40);
    now = 250; await wheel(-40); expect(select).not.toHaveBeenCalled();
    now = 270; await wheel(-20); expect(select).toHaveBeenLastCalledWith("set-app");
  });
  it("兼容按行及按页滚轮单位", async () => {
    await render(); panel().scrollTop = 400; await wheel(4, panel(), {deltaMode:1});
    expect(select).toHaveBeenLastCalledWith("set-terminal");
    now = 400; panel().scrollTop = 400; await wheel(1, panel(), {deltaMode:2});
    expect(select).toHaveBeenLastCalledWith("set-network");
  });
  it("不抢表单、下拉菜单、终端预览和修饰键滚轮", async () => {
    await render(); panel().scrollTop = 400;
    for (const target of panel().querySelectorAll('input,textarea,select,[role="listbox"],.xterm')) await wheel(100, target);
    for (const options of [{ctrlKey:true},{shiftKey:true},{metaKey:true},{altKey:true},{deltaX:10}]) await wheel(100, panel(), options);
    expect(select).not.toHaveBeenCalled();
  });
  it("嵌套列表先滚动自身，contain 在边界也不触发分类切换", async () => {
    await render(); panel().scrollTop = 400;
    const inner = panel().querySelector<HTMLElement>('[data-nested]')!; size(inner,100,500);
    await wheel(100, inner); expect(select).not.toHaveBeenCalled();
    inner.scrollTop = 400; inner.style.overscrollBehaviorY = "contain";
    await wheel(100, inner); expect(select).not.toHaveBeenCalled();
    inner.style.overscrollBehaviorY = "auto"; await wheel(100, inner);
    expect(select).toHaveBeenLastCalledWith("set-terminal");
  });
  it("隐藏分类与非活动设置页不响应，卸载后移除监听", async () => {
    await render(); const hidden = host.querySelector<HTMLElement>('[data-category="set-terminal"]')!;
    hidden.scrollTop = 400; await wheel(100, hidden); expect(select).not.toHaveBeenCalled();
    await render("set-app", false); panel().scrollTop = 400; const oldPanel = panel(); await wheel(100);
    expect(select).not.toHaveBeenCalled();
    await act(async () => root.render(null)); await wheel(100, oldPanel);
    expect(select).not.toHaveBeenCalled();
  });
  it("可滚内容仍由全局轻惯性处理，边缘换区不为下一页排入惯性动画", async () => {
    await render();
    vi.spyOn(document,"hidden","get").mockReturnValue(false);
    vi.stubGlobal("matchMedia",()=>Object.assign(new EventTarget(),{matches:false}));
    const raf = vi.fn(() => 1); vi.stubGlobal("requestAnimationFrame",raf); vi.stubGlobal("cancelAnimationFrame",vi.fn());
    const cleanup = attachPageInertia(document);
    try {
      expect((await wheel(100)).defaultPrevented).toBe(true); expect(raf).toHaveBeenCalledOnce();
      raf.mockClear(); panel().scrollTop = 400; await wheel(100);
      expect(select).toHaveBeenLastCalledWith("set-terminal"); expect(raf).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
