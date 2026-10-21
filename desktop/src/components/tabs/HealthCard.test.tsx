// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { HealthCard } from "./HealthCard";
import type { StaticStatus } from "../../lib/types";

vi.mock("../../hooks/useLiveStatus", () => ({ useLiveStatus: () => ({ data: { stats: { totalRequests: 0 } } }) }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
const base = {
  running: true, whitelistEnabled: true, auditEnabled: true, rateLimitEnabled: true,
  backupEnabled: true, allowedRoots: [], rateLimit: { windowMs: 60000, maxRequests: 100 },
  backupCount: 12, backupRetention: 10, readonlyMode: false, shellEnabled: true,
  shellType: "bash", sessionCwdEnabled: false, encodingDetectEnabled: true,
} as unknown as StaticStatus;
function render(overrides: Partial<StaticStatus> = {}) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<HealthCard status={{ ...base, ...overrides }} />);
  return host;
}
const pill = (host: HTMLElement, prefix: string) => [...host.querySelectorAll(".gov-pill")].find(e => e.textContent?.startsWith(prefix))!;

it("防护配置齐全与整体风险分开表达，无调用时不声称健康", () => {
  const host = render();
  expect(host.textContent).toContain("基础防护已开启");
  expect(host.textContent).toContain("暂无调用 · 待评估");
  expect(host.textContent).not.toContain("推荐状态");
  expect(pill(host, "命令执行 开").classList.contains("gov-pill--warn")).toBe(true);
});
it("基础防护缺项时明确提示，关闭只读不会显示绿色对勾", () => {
  const host = render({ auditEnabled: false });
  expect(host.textContent).toContain("基础防护未齐");
  expect(pill(host, "只读模式 关").querySelector("svg")).toBeNull();
  expect(pill(host, "只读模式 关").classList.contains("gov-pill--ok")).toBe(false);
});
it("开启只读时呈现防护对勾", () => {
  expect(pill(render({ readonlyMode: true }), "只读模式 开").querySelector("svg")).not.toBeNull();
});
it.each([true, false])("普通配置状态为 %s 时保留真实文案，使用中性展示", enabled => {
  const host = render({ sessionCwdEnabled: enabled, encodingDetectEnabled: enabled });
  for (const prefix of ["会话持久化", "编码探测"]) {
    const node = pill(host, prefix);
    expect(node.textContent).toContain(enabled ? "开" : "关");
    expect(node.querySelector("svg")).toBeNull();
    expect(node.classList.contains("gov-pill--warn")).toBe(false);
  }
});
