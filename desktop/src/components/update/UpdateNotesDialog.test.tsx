// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateNotesDialog } from "./UpdateNotesDialog";
import type { UpdateNotesInfo } from "../../lib/updateNotes";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const close = vi.fn(), download = vi.fn(), dismiss = vi.fn();
const props = { open: true, update: { version: "99.0.0", currentVersion: "2.9.1", body: "### 亮点\n- **更稳定**：可靠复制\n### 修复\n- <img src=x onerror=alert(1)>" }, onClose: close, onDownload: download, onDismiss: dismiss };
const button = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text))!;

beforeEach(() => { vi.clearAllMocks(); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); });
async function mount(update: UpdateNotesInfo = props.update) { await act(async () => root.render(<UpdateNotesDialog {...props} update={update} />)); }

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
  it("纯文字说明原样保留，无从汇总时不伪造统计与亮点", async () => {
    await mount({ ...props.update, body: "plain note" });
    await act(async () => button("本次发布").click());
    expect(document.querySelector('.update-release-notes')?.textContent).toContain('plain note');
    // 🔴 必须显式去掉 currentVersion：只要给了它，模型就会按 2.9.1 → 99.0.0 汇总**随包的** CHANGELOG，
    // 记录数与亮点条目随每次发版变化 —— 原断言（指望 .update-stats 为空）因此成了时间炸弹，
    // 2026-10-20 发版后实际渲染出「55 条更新记录 / 28 改进」而变红。
    // 拿不到当前版本 = 无从判断升级范围 ⇒ 不做跨版本汇总，这才是「没有说明就没有统计」的真实前提。
    await mount({ ...props.update, body: "", currentVersion: undefined });
    expect(document.body.textContent).toContain("此版本未提供详细说明");
    expect(document.querySelector('.update-stats')).toBeNull();
    expect(document.querySelector('.update-benefits')).toBeNull();
  });

  it("有当前版本时按区间汇总随包记录（stats 与亮点反映累计，不是本次发布的伪统计）", async () => {
    // 与上一条互补：证明 stats 的出现条件是「存在可汇总的区间」，而不是 body 里有没有字。
    await mount({ ...props.update, body: "", currentVersion: "2.9.1" });
    expect(document.body.textContent).toContain("汇总已收录的");
    expect(document.querySelector('.update-stats')).not.toBeNull();
    // 本次发布没有说明 ⇒ 详情区仍要诚实地说没有，不能用汇总内容冒充。
    expect(document.body.textContent).toContain("此版本未提供详细说明");
  });
});
