// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateNotesDialog } from "./UpdateNotesDialog";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const close = vi.fn(), download = vi.fn(), dismiss = vi.fn();
const props = { open: true, update: { version: "99.0.0", currentVersion: "2.9.1", body: "### 亮点\n- **更稳定**：可靠复制\n### 修复\n- <img src=x onerror=alert(1)>" }, onClose: close, onDownload: download, onDismiss: dismiss };
const button = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text))!;

beforeEach(() => { vi.clearAllMocks(); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); });
async function mount(update = props.update) { await act(async () => root.render(<UpdateNotesDialog {...props} update={update} />)); }

describe("update dialog behavior", () => {
  it("关闭不抑制当前版本，也不会触发下载", async () => {
    await mount();
    await act(async () => (document.querySelector('[aria-label="关闭更新弹窗"]') as HTMLButtonElement).click());
    expect(close).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
  it("稍后仍按原有顺序抑制并关闭", async () => {
    await mount(); await act(async () => button("稍后").click());
    expect(dismiss).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(dismiss.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(download).not.toHaveBeenCalled();
  });
  it("下载仍按原有顺序发起并关闭，不写稍后记忆", async () => {
    await mount(); await act(async () => button("下载并更新").click());
    expect(download).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(download.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("记录按需挂载，远端内容以安全文本呈现，切换版本重置折叠", async () => {
    await mount();
    expect(document.querySelector('.update-release-notes')).toBeNull();
    await act(async () => button("本次发布").click());
    expect(document.querySelector('.update-release-notes')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelectorAll('img')).toHaveLength(1);
    await mount({ ...props.update, version: "100.0.0" });
    expect(button("本次发布").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('.update-release-notes')).toBeNull();
  });
  it("纯文字保留，缺少说明时没有虚假统计与亮点", async () => {
    await mount({ ...props.update, body: "plain note" });
    await act(async () => button("本次发布").click());
    expect(document.querySelector('.update-release-notes')?.textContent).toContain('plain note');
    await mount({ ...props.update, body: "" });
    expect(document.body.textContent).toContain("此版本未提供详细说明");
    expect(document.querySelector('.update-stats')).toBeNull();
    expect(document.querySelector('.update-benefits')).toBeNull();
  });
});
