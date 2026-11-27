// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTransferPrompt } from "./useTransferPrompt";

it("切连接卸载后，迟到的冲突直接取消，调用方不会一直等待", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let ask!: ReturnType<typeof useTransferPrompt>["askOverwrite"];
  function Harness() { ask = useTransferPrompt().askOverwrite; return null; }
  try {
    await act(async () => root.render(<Harness/>));
    await act(async () => root.unmount());
    const timeout = Symbol("unresolved");
    expect(await Promise.race([ask({ kind: "down", path: "D:/one", names: ["one"] }), Promise.resolve(timeout)])).toBe("cancel");
  } finally { vi.unstubAllGlobals(); }
});
