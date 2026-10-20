// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "./Menu";
import { ViewActivityContext } from "../../lib/viewActivity";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const run = vi.fn();
const render = async (portal = true, active = true) => act(async () => root.render(<ViewActivityContext.Provider value={active}><Menu portal={portal} trigger={(open, toggle) => <button aria-expanded={open} onClick={toggle}>操作</button>}>{close => <><MenuItem label="文件" onClick={() => { run(); close(); }}/><MenuItem label="编辑" onClick={close}/></>}</Menu></ViewActivityContext.Provider>));
const click = async (element: Element) => act(async () => (element as HTMLButtonElement).click());
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("menus in scrollable SSH sidebar", () => {
  it("浮层挂到 body；菜单内点击不会被外部点击处理器抢先关闭", async () => {
    await render(); await click(container.querySelector("button")!);
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.parentElement).toBe(document.body);
    const item = menu.querySelector("button")!;
    await act(async () => item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click(item);
    expect(run).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("键盘可从触发器进入浮层；Esc 关闭并把焦点还给触发器", async () => {
    await render(); const trigger = container.querySelector("button")!;
    await click(trigger); trigger.focus();
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("文件");
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("编辑");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it.each(["resize", "scroll"])("%s 后关闭旧坐标浮层", async event => {
    await render(); await click(container.querySelector("button")!);
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("切离终端页时关闭浮层；原有普通菜单保持就地渲染", async () => {
    await render(); await click(container.querySelector("button")!); await render(true, false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await render(false); await click(container.querySelector("button")!);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});
