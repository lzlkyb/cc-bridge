// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshFileEditorStatus } from "./SshFileEditorStatus";

let root: Root;
let host: HTMLDivElement;

function render(props: Partial<Parameters<typeof SshFileEditorStatus>[0]> = {}) {
  return act(async () => {
    root.render(
      <SshFileEditorStatus
        encoding="utf-8"
        lineEnding="lf"
        lineCount={2}
        size={12}
        dirty={false}
        conflict={false}
        readOnly={false}
        remoteMtime={0}
        endpoint="u@h"
        loading={false}
        {...props}
      />,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("编码标签由后端带回：GBK 文件状态栏显示 GBK（不再写死 UTF-8）", async () => {
  await render({ encoding: "gbk" });
  const spans = [...host.querySelectorAll("span")].map((s) => s.textContent);
  expect(spans[0]).toBe("GBK");
  expect(spans[1]).toBe("LF");
});

it("UTF-8 文件仍显示 UTF-8", async () => {
  await render();
  const spans = [...host.querySelectorAll("span")].map((s) => s.textContent);
  expect(spans[0]).toBe("UTF-8");
});

it("未知编码标签原样显示，不吞成 UTF-8（避免状态栏对用户说谎）", async () => {
  await render({ encoding: "big5" });
  const spans = [...host.querySelectorAll("span")].map((s) => s.textContent);
  expect(spans[0]).toBe("big5");
});
