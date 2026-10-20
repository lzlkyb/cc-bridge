import type { ButtonHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar, WorkspaceTabs } from "./terminal-workspace";
import type { SshConnection } from "../lib/types";
import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";

vi.mock("../components/ui/button", () => ({ Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}/> }));
const conn = { id: "prod", name: "生产服务器", username: "deploy", host: "192.0.2.10", port: 22 } as SshConnection;
const session = { conn, tabId: "a", sessionId: "a", closedReason: null } as SshSessionRef;
const noop = () => {};
const tabProps = { activeId: "a", onActivate: noop, onDisconnect: noop, onClose: noop, onNew: noop, split: false, onSplit: noop, onSearch: noop };

describe("workspace layout preview session identity", () => {
  it("同一主机的多个会话有序号，断开态关闭动作与活会话断开动作分开", () => {
    const html = renderToStaticMarkup(<WorkspaceTabs {...tabProps} sessions={[session, { ...session, tabId: "b", sessionId: "b", closedReason: "已断开" }]}/>);
    expect(html).toContain("生产服务器 #1");
    expect(html).toContain("生产服务器 #2");
    expect(html).toContain('aria-label="生产服务器断开会话"');
    expect(html).toContain('aria-label="生产服务器关闭标签"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  });

  it("只有一个会话时不展示多余序号，分屏入口反馈选中态", () => {
    const html = renderToStaticMarkup(<WorkspaceTabs {...tabProps} sessions={[session]} split/>);
    expect(html).not.toContain("生产服务器 #1");
    expect(html).toContain('aria-label="分屏" aria-pressed="true"');
  });

  it("侧栏已连接数量排除断开会话，主机仍保留可辨识的登录地址", () => {
    const html = renderToStaticMarkup(<WorkspaceSidebar connections={[conn]} sessions={[session, { ...session, sessionId: "b", tabId: "b", closedReason: "已断开" }]} activeId="a" collapsed={false} onConnect={noop} onNewTerminal={noop} onDisconnect={noop} notify={noop}/>);
    expect(html).toContain("1 个会话已连接");
    expect(html).toContain("deploy@192.0.2.10:22");
    expect(html.match(/data-connected="true"/g)).toHaveLength(1);
  });

  it("没有活会话时不把服务器显示为已连接", () => {
    const html = renderToStaticMarkup(<WorkspaceSidebar connections={[conn]} sessions={[{ ...session, closedReason: "已断开" }]} activeId="a" collapsed onConnect={noop} onNewTerminal={noop} onDisconnect={noop} notify={noop}/>);
    expect(html).toContain("0 个会话已连接");
    expect(html).not.toContain('data-connected="true"');
    expect(html).toContain('data-collapsed="true"');
  });
});
