// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { appendCcDraft, quoteCcText } from "./ccDraftInsert";
it("引用输出仅发送给所属对话，不影响其他草稿", () => {
  const a=document.createElement("div"),b=document.createElement("div"),source=document.createElement("button");
  a.dataset.ccPanel=""; b.dataset.ccPanel=""; a.append(source);
  const first=vi.fn(),second=vi.fn(); a.addEventListener("cc-append-draft",first); b.addEventListener("cc-append-draft",second);
  appendCcDraft(source,"原始输出"); expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  expect((first.mock.calls[0][0] as CustomEvent).detail).toBe("原始输出");
});
it("多行引用保留原始换行",()=>expect(quoteCcText("甲\n乙")).toBe("> 甲\n> 乙\n\n"));
