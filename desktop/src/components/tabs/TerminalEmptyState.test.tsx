import type { ButtonHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SshConnection } from "../../lib/types";
import { TerminalEmptyState } from "./TerminalEmptyState";

vi.mock("../../hooks/useTerminalAppearance", () => ({ useTerminalThemeMode: () => "dark" }));
vi.mock("../../hooks/useTerminalPreset", () => ({ useTerminalPreset: () => "indigo" }));
// 此处验证空态的任务和状态分支；真实按钮样式及点击由浏览器回归覆盖。
vi.mock("../ui/button", () => ({ Button: ({ variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button data-variant={variant} {...props} /> }));

const connections = Array.from({ length: 10 }, (_, index) => ({
  id: `host-${index}`, name: `服务器 ${index}`, host: `server-${index}.example.test`,
  username: "developer", port: 2222,
})) as SshConnection[];
const props = { collapsed: true, onExpand: () => {}, onNew: () => {}, onConnect: () => {}, connections };
const hostButtons = (html: string) => html.match(/<button[^>]+class="terminal-picker-host"[^>]*>/g) ?? [];

describe("terminal empty-state task flow", () => {
  it.each([true, false])("没有连接时提供创建入口（侧栏收起=%s）", collapsed => {
    const html = renderToStaticMarkup(<TerminalEmptyState {...props} collapsed={collapsed} connections={[]} />);
    expect(html).toContain("添加第一个 SSH 连接");
    expect(html).toContain('data-primary="true"');
    expect(html).not.toContain("已保存的连接");
    expect(hostButtons(html)).toHaveLength(0);
  });

  it("单个主机显示名称和实际登录地址，创建是次操作", () => {
    const html = renderToStaticMarkup(<TerminalEmptyState {...props} connections={connections.slice(0, 1)} />);
    expect(hostButtons(html)).toHaveLength(1);
    expect(html).toContain("developer@server-0.example.test:2222");
    expect(html).toContain('aria-label="连接 服务器 0"');
    expect(html).toContain("展开列表");
    expect(html).not.toContain("data-primary");
  });

  it("主机多时只显示现有顺序的前三个，保留完整列表入口", () => {
    const html = renderToStaticMarkup(<TerminalEmptyState {...props} />);
    expect(hostButtons(html)).toHaveLength(3);
    expect(html.indexOf("服务器 0")).toBeLessThan(html.indexOf("服务器 2"));
    expect(html).not.toContain("服务器 3");
    expect(html).toContain("展开列表");
  });

  it("侧栏展开时中央不重复主机列表与新建操作", () => {
    const html = renderToStaticMarkup(<TerminalEmptyState {...props} collapsed={false} />);
    expect(html).toContain("从左侧选择连接");
    expect(hostButtons(html)).toHaveLength(0);
    expect(html).not.toContain("<button");
  });

  it("连接期间显示真实目标并禁用重复发起，结束后恢复", () => {
    const busy = renderToStaticMarkup(<TerminalEmptyState {...props} connectingId="host-1" />);
    expect(hostButtons(busy).every(button => button.includes('disabled=""'))).toBe(true);
    expect(hostButtons(busy).filter(button => button.includes('aria-busy="true"'))).toHaveLength(1);
    expect(busy).toContain("连接中");
    const idle = renderToStaticMarkup(<TerminalEmptyState {...props} connectingId={null} />);
    expect(hostButtons(idle).every(button => !button.includes("disabled"))).toBe(true);
  });

  it("没有名称的 IPv6 主机仍有可辨识标签和无歧义地址", () => {
    const html = renderToStaticMarkup(<TerminalEmptyState {...props} connections={[{ ...connections[0], name: "", host: "2001:db8::1" }]} />);
    expect(html).toContain('aria-label="连接 2001:db8::1"');
    expect(html).toContain("developer@[2001:db8::1]:2222");
  });
});
