// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Sparkline, type ChartKind } from "./MetricSparkline";

function render(series: number[], kind: ChartKind, noData = false) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Sparkline series={series} kind={kind} noData={noData} />);
  return host;
}
it("无调用数据时不把零延迟画成正常的绿色图表", () => {
  const host = render([0, 0], "bars", true);
  expect(host.textContent).toBe("暂无调用数据");
  expect(host.querySelector("svg")).toBeNull();
});
it("当前无新数据仍保留之前的非零历史", () => {
  const host = render([150, 0], "bars", true);
  expect(host.querySelector("rect")).not.toBeNull();
  expect(host.textContent).not.toContain("暂无调用数据");
});
it.each<ChartKind>(["area", "bars", "heat", "step"])("%s 的真实零采样保留中性基线", kind => {
  const host = render([0, 0], kind);
  expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("当前采样均为 0");
  expect(host.querySelectorAll("line").length).toBe(1);
  expect(host.querySelectorAll("rect, polyline, .metric-spark__tip").length).toBe(0);
});
it("采样不足与真实零采样区分，单个柱形采样可以展示", () => {
  expect(render([0], "area").textContent).toBe("采样中…");
  expect(render([], "heat").textContent).toBe("采样中…");
  expect(render([30], "bars").querySelector("rect")).not.toBeNull();
});
