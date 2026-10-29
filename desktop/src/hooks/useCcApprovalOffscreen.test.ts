// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { firstOffscreenApproval } from "./useCcApprovalOffscreen";

it("优先定位未完整显示的审批，而不是总返回第一项", () => {
  const root = document.createElement("div");
  root.innerHTML = '<div data-cc-approval></div><div data-cc-approval></div>';
  const cards = root.querySelectorAll<HTMLElement>("[data-cc-approval]");
  const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(rect(0, 200));
  vi.spyOn(cards[0], "getBoundingClientRect").mockReturnValue(rect(10, 90));
  vi.spyOn(cards[1], "getBoundingClientRect").mockReturnValue(rect(180, 250));
  expect(firstOffscreenApproval(root)).toBe(cards[1]);
});
