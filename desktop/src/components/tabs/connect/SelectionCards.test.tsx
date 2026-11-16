// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AddressPicker } from "./AddressPicker";
import { OptionCard } from "./widgets";
import { ToastProvider } from "../../ui/toast";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({
  data: [{ ip: "10.0.7.185", state: "ok" }, { ip: "10.203.5.58", state: "fail" }],
  refetch: vi.fn(), isFetching: false, isError: false,
}) }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

function Choices() {
  const [ip, setIp] = useState("10.0.7.185");
  const [project, setProject] = useState(true);
  return <ToastProvider>
    <AddressPicker ips={["10.0.7.185", "10.203.5.58"]} selected={ip} onSelect={setIp} port={7823} healthCheck="curl /health" />
    <OptionCard selected={project} title="项目级" desc="仅指定项目生效" onClick={() => setProject(true)} />
    <OptionCard selected={!project} title="全局模式" desc="所有项目可用" onClick={() => setProject(false)} />
  </ToastProvider>;
}
const cards = () => [...host.querySelectorAll<HTMLButtonElement>(".selection-card")];

it("地址与模式的选择可独立切换，探测结果不替代选中标记", async () => {
  await act(async () => root.render(<Choices />));
  const [first, second, project, global] = cards();
  expect(first.getAttribute("aria-pressed")).toBe("true");
  expect(first.querySelector(".selection-card-check")).not.toBeNull();
  expect(first.textContent).toContain("✓ 通");
  expect(second.textContent).toContain("× 不通");
  await act(async () => second.click());
  expect(first.getAttribute("aria-pressed")).toBe("false");
  expect(first.querySelector(".selection-card-check")).toBeNull();
  expect(first.textContent).toContain("✓ 通");
  expect(second.getAttribute("aria-pressed")).toBe("true");
  expect(second.querySelector(".selection-card-check")).not.toBeNull();
  expect(second.textContent).toContain("× 不通");
  expect(project.getAttribute("aria-pressed")).toBe("true");
  await act(async () => global.click());
  expect(project.getAttribute("aria-pressed")).toBe("false");
  expect(global.getAttribute("aria-pressed")).toBe("true");
  expect(global.querySelector(".selection-card-check")).not.toBeNull();
  expect(second.getAttribute("aria-pressed")).toBe("true");
});

it("选择按钮不提交外层表单，装饰勾不重复播报", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  await act(async () => root.render(<form onSubmit={submit}><Choices /></form>));
  for (const card of cards()) {
    expect(card.type).toBe("button");
    await act(async () => card.click());
  }
  expect(submit).not.toHaveBeenCalled();
  for (const check of host.querySelectorAll(".selection-card-check")) {
    expect(check.getAttribute("aria-hidden")).toBe("true");
  }
});

/**
 * 2026-11-16 用户反馈：「复制地址更新命令」点了没反应。
 * 通用 MCP 工具（generic）没有约定配置文件 → Rust 返回空命令 → 入口只弹一条 toast 就
 * 返回 false，按钮外观毫无变化。现在禁用 + 说明原因，不留一个静默失败的控件。
 */
async function renderCopy(onCopySed: () => boolean, commandAvailable: boolean) {
  await act(async () =>
    root.render(
      <ToastProvider>
        <AddressPicker
          ips={["10.0.7.185"]}
          selected="10.0.7.185"
          onSelect={() => {}}
          port={7823}
          healthCheck="curl /health"
          onCopySed={onCopySed}
          commandAvailable={commandAvailable}
        />
      </ToastProvider>,
    ),
  );
}
const copyBtn = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes("复制地址更新命令") || (b.textContent ?? "").includes("需手动更新地址"),
  );

it("没有约定配置文件时复制按钮禁用、给出原因且不触发入口", async () => {
  const onCopySed = vi.fn(() => true);
  await renderCopy(onCopySed, false);
  const btn = copyBtn()!;
  expect(btn).toBeDefined();
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toContain("需手动更新地址");
  expect(host.textContent).toContain("没有约定的配置文件");
  await act(async () => btn.click());
  expect(onCopySed).not.toHaveBeenCalled();
});

it("有约定配置文件时复制按钮可用并正常触发入口", async () => {
  const onCopySed = vi.fn(() => true);
  await renderCopy(onCopySed, true);
  const btn = copyBtn()!;
  expect(btn.disabled).toBe(false);
  expect(host.textContent).not.toContain("没有约定的配置文件");
  await act(async () => btn.click());
  expect(onCopySed).toHaveBeenCalledTimes(1);
});
