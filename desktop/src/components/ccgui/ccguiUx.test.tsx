// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcApproval } from "../../lib/ccGuiTypes";
import { ApprovalCard } from "./ApprovalCard";
import { CcEmptyState } from "./CcEmptyState";
import { QuestionCard } from "./QuestionCard";
import { ScrollToBottom } from "./ScrollToBottom";
import { SessionRow, type SessionRowData } from "./SessionSidebarRow";
import { UserMessageBubble } from "./UserMessageBubble";

/**
 * 对话页 UX 修复的行为锁：回到底部浮钮、侧栏行的键盘 / 关闭确认、
 * 用户消息的分叉禁用、审批 / 提问卡超时后不可点。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const show = (node: React.ReactNode) => act(async () => root.render(node));
/**
 * 带 QueryClient 的渲染壳。
 *
 * 审批卡要读 `["status"]` 缓存（「以后都放行这类」得在现有规则表上追加），
 * 而 `useQueryClient` 在 Provider 外面直接抛 —— 用真 Provider 而不是 mock
 * 整条链路：被测的正是「点了按钮之后卡片还正不正常」，把 hook 换掉测的就不是它了。
 * `retry: false` = 查询失败别退避重试，否则 unmount 后还会留着定时器。
 */
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const showWithQuery = (node: React.ReactNode) =>
  show(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const byText = (t: string) => buttons().find((b) => b.textContent?.trim() === t);
const click = (el: Element | undefined) => act(async () => (el as HTMLElement).click());
/** ConfirmDialog 的确认 / 取消要先走退场动画再触发回调，等它跑完。 */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 600))));

describe("ScrollToBottom", () => {
  it("有待批准时写明条数，否则为普通文案", async () => {
    await show(<ScrollToBottom pending={2} running={false} onClick={() => {}} />);
    expect(container.textContent).toContain("有 2 条待批准");
    await show(<ScrollToBottom pending={0} running onClick={() => {}} />);
    expect(container.textContent).toContain("回到底部 · 生成中");
    await show(<ScrollToBottom pending={0} running={false} onClick={() => {}} />);
    expect(container.textContent?.trim()).toBe("回到底部");
  });

  it("点击触发回调", async () => {
    const onClick = vi.fn();
    await show(<ScrollToBottom pending={0} running={false} onClick={onClick} />);
    await click(container.querySelector("button")!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

const row = (state: SessionRowData["state"]): SessionRowData => ({
  key: "k1",
  meta: null,
  restore: { kind: "none" },
  title: "修一个 bug",
  detail: "3 轮",
  state,
  label: "本机",
});

describe("SessionRow", () => {
  const renderRow = (state: SessionRowData["state"], over: Partial<{ onClose: () => void; onPick: () => void }> = {}) =>
    show(
      <SessionRow
        row={row(state)}
        active={false}
        canClose
        archivedRows={{}}
        onPick={over.onPick ?? (() => {})}
        onClose={over.onClose ?? (() => {})}
        onRename={async () => {}}
        onArchive={async () => {}}
      />,
    );
  const closeBtn = () => document.body.querySelector<HTMLButtonElement>('[aria-label^="关闭会话："]');

  it("空闲会话点 × 直接关闭", async () => {
    const onClose = vi.fn();
    await renderRow("idle", { onClose });
    await click(closeBtn()!);
    expect(onClose).toHaveBeenCalledWith("k1");
  });

  it.each(["run", "ask", "wait"] as const)("%s 状态点 × 先确认，确认后才关", async (state) => {
    const onClose = vi.fn();
    await renderRow(state, { onClose });
    await click(closeBtn()!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("关闭这条会话");
    await click(byText("关闭会话"));
    await settle();
    expect(onClose).toHaveBeenCalledWith("k1");
  });

  it("确认框里点「取消」不关、也不触发选中该行", async () => {
    const onClose = vi.fn();
    const onPick = vi.fn();
    await renderRow("run", { onClose, onPick });
    await click(closeBtn()!);
    await click(byText("取消"));
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("关闭这条会话");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("行可用键盘选中（Enter / Space），内部按钮的键不被行拦走", async () => {
    const onPick = vi.fn();
    await renderRow("idle", { onPick });
    const el = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(el.tabIndex).toBe(0);
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledTimes(2);
    await act(async () => {
      closeBtn()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledTimes(2);
  });
});

describe("UserMessageBubble 分叉", () => {
  const bubble = (text: string, images?: string[]) =>
    show(<UserMessageBubble text={text} images={images} onFork={() => {}} />);

  it("纯图片消息禁用「从此处分叉」（原图不落盘，分叉出来是空会话）", async () => {
    await bubble("", ["data:image/png;base64,AAAA"]);
    expect(byText("从此处分叉")!.disabled).toBe(true);
  });

  it("带图且有文字时可分叉，但提示图片不会带过去", async () => {
    await bubble("看这张图", ["data:image/png;base64,AAAA"]);
    const fork = byText("从此处分叉")!;
    expect(fork.disabled).toBe(false);
    expect(fork.title).toContain("图片不会带到新会话");
    expect(byText("编辑并重发")!.title).toContain("图片不会带到新会话");
  });

  it("纯文字消息分叉不带多余提示", async () => {
    await bubble("你好");
    const fork = byText("从此处分叉")!;
    expect(fork.disabled).toBe(false);
    expect(fork.title).toBe("");
  });
});

describe("审批 / 提问卡超时", () => {
  const approval = (over: Partial<CcApproval> = {}): CcApproval => ({
    kind: "approval",
    id: "r1",
    toolName: "Bash",
    input: { command: "ls" },
    reason: "要执行命令",
    expiresInSec: 60,
    ...over,
  });

  it("倒计时未归零时按钮可用", async () => {
    await showWithQuery(
      <ApprovalCard approval={approval()} onAllow={() => {}} onDeny={() => {}} onAnswer={() => {}} />,
    );
    expect(byText("拒绝")!.disabled).toBe(false);
    expect(byText("允许一次")!.disabled).toBe(false);
    expect(container.querySelector('[role="group"]')).not.toBeNull();
  });

  it("审批卡归零后按钮禁用并说明已超时", async () => {
    await showWithQuery(
      <ApprovalCard approval={approval({ expiresInSec: 0 })} onAllow={() => {}} onDeny={() => {}} onAnswer={() => {}} />,
    );
    expect(container.textContent).toContain("已超时");
    expect(byText("拒绝")!.disabled).toBe(true);
    expect(byText("允许一次")!.disabled).toBe(true);
  });

  it("提问卡归零后选项、跳过、提交都禁用", async () => {
    const q = approval({
      toolName: "AskUserQuestion",
      expiresInSec: 0,
      questions: [{ question: "吃什么？", options: [{ label: "面" }, { label: "饭" }] }],
    });
    await show(<QuestionCard approval={q} onSubmit={() => {}} onSkip={() => {}} />);
    expect(container.textContent).toContain("已超时");
    expect(byText("跳过")!.disabled).toBe(true);
    expect(byText("提交")!.disabled).toBe(true);
    expect(buttons().filter((b) => b.getAttribute("aria-pressed") !== null).every((b) => b.disabled)).toBe(true);
  });
});

describe("CcEmptyState", () => {
  const empty = (over: Partial<Parameters<typeof CcEmptyState>[0]> = {}) =>
    show(
      <CcEmptyState
        probe={{ found: true, path: "claude", version: "1.0.0", message: "", target: "" }}
        probing={false}
        onRetryProbe={() => {}}
        onPickPrompt={() => {}}
        cwd=""
        onCwdChange={() => {}}
        isRemote={false}
        newSessionHint="Ctrl+N"
        {...over}
      />,
    );

  it("点示例 prompt 走 onPickPrompt（填入输入框），而不是直接发送", async () => {
    const onPickPrompt = vi.fn();
    await empty({ onPickPrompt });
    const first = buttons().find((b) => b.textContent?.includes("看一下这个项目的结构"))!;
    await click(first);
    expect(onPickPrompt).toHaveBeenCalledWith("看一下这个项目的结构，告诉我它是干什么的");
  });

  it("改工作目录：停止输入后显示「已应用」，输入过程中不闪", async () => {
    const onCwdChange = vi.fn();
    await empty({ onCwdChange });
    const input = container.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "D:\\proj");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onCwdChange).toHaveBeenCalledWith("D:\\proj");
    expect(container.textContent).not.toContain("已应用");
    await act(async () => void (await new Promise((r) => setTimeout(r, 700))));
    expect(container.textContent).toContain("已应用，下一条消息生效");
  });
});
