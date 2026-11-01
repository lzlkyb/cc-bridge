// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

/**
 * slash 命令面板 + 白名单闸门 + @引用补全的行为锁。
 *
 * 为什么值得单测：面板的「自动开合」由正则派生，闸门的「什么能出去」是安全
 * 边界，@引用的「选中目录续写 / 选中文件收尾」是 token 状态机——三者坏了都
 * 不报错，只会安静地要么不弹面板、要么把未知命令当提示词发给模型浪费一轮。
 */
vi.mock("../../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_status") return { allowedRoots: ["D:\\proj"] };
    if (cmd === "browse_directory") {
      const p = String(args.path);
      return {
        path: p,
        parent: null,
        entries: [
          { name: "src", path: `${p}\\src`, isDir: true },
          { name: "readme.md", path: `${p}\\readme.md`, isDir: false },
        ],
      };
    }
    throw new Error(`测试未预期地调用了 ${cmd}`);
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, qc: QueryClient;
const onSend = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // 草稿会落 localStorage：用例之间串了就会出现「输入框初始带着上一条用例的字」
  // （`readDraft` 是 `useState` 的惰性初值，装配那一刻就读）。
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  qc.clear();
});

async function render(props: Partial<ComponentProps<typeof Composer>> = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <Composer
          onSend={onSend}
          queueCount={0}
          onClearQueue={() => {}}
          draftKey="test-pane"
          mentionSource={{ connectionId: "", cwd: "D:\\work" }}
          {...props}
        />
      </QueryClientProvider>,
    );
  });
}
/** 层级解析在下钻 effect 里异步跑，等微任务 + 一帧再断言。 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
function area() {
  return container.querySelector("textarea")!;
}
/** React 受控 textarea：必须走原生 setter 再派发 input，直接赋 value 不触发 onChange。 */
async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area(), text);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    area().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}
function panelText() {
  return container.querySelector('[aria-label="slash 命令"]')?.textContent ?? "";
}
function mentionText() {
  return container.querySelector('[aria-label="引用文件或目录"]')?.textContent ?? "";
}
async function clickSend() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-cc-send]")!.click();
  });
}

it("运行中默认补充；Ctrl Enter 立即调整且输入法组合不会误发", async () => {
  const onSteer = vi.fn().mockResolvedValue(true), onSendNow = vi.fn().mockResolvedValue(true);
  await render({ running: true, onSteer, onSendNow });
  await type("补充范围"); await clickSend();
  expect(onSteer).toHaveBeenCalledWith("补充范围", []);
  expect(onSend).not.toHaveBeenCalled();
  await type("立即调整");
  await key("Enter", { ctrlKey: true, isComposing: true });
  expect(onSendNow).not.toHaveBeenCalled();
  await key("Enter", { ctrlKey: true });
  expect(onSendNow).toHaveBeenCalledWith("立即调整", []);
  expect(area().value).toBe("");
});

it("下一轮发送是独立选项，命令始终延后发送", async () => {
  const onSteer = vi.fn().mockResolvedValue(true), onSendNow = vi.fn().mockResolvedValue(true);
  await render({ running: true, onSteer, onSendNow });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择发送方式"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("下一轮发送"))!.click());
  await type("下轮单独审查"); await clickSend();
  expect(onSend).toHaveBeenCalledWith("下轮单独审查", []);
  expect(onSteer).not.toHaveBeenCalled();
  await type("/compact"); await clickSend();
  expect(onSend).toHaveBeenLastCalledWith("/compact", []);
  expect(onSendNow).not.toHaveBeenCalled();
});

it("补充失败保留草稿，发送期间新草稿不会被完成回调清掉", async () => {
  let finish!: (accepted: boolean) => void;
  const onSteer = vi.fn().mockResolvedValueOnce(false).mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
  await render({ running: true, onSteer });
  await type("保留原稿"); await clickSend();
  expect(area().value).toBe("保留原稿");
  await clickSend();
  await type("新的草稿");
  await act(async () => finish(true));
  expect(area().value).toBe("新的草稿");
  expect(onSteer).toHaveBeenCalledTimes(2);
});

it("恢复插话文字只填草稿，不触发重发", async () => {
  await render({ inputs: { a: { messageId: "a", text: "需要找回的补充", status: "unconfirmed" } } });
  await type("现有草稿");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "恢复文字")!.click());
  expect(area().value).toBe("现有草稿\n需要找回的补充");
  expect(onSend).not.toHaveBeenCalled();
});

it("打出 / 浮出白名单面板", async () => {
  await render();
  await type("/");
  expect(panelText()).toContain("/compact");
  expect(panelText()).toContain("/clear");
  expect(panelText()).toContain("/model");
});

it("随输入过滤，没有匹配走空态提示", async () => {
  await render();
  await type("/c");
  expect(panelText()).toContain("/compact");
  expect(panelText()).not.toContain("/model");
  await type("/xyz");
  expect(panelText()).toContain("没有匹配");
  expect(panelText()).toContain("只转发");
});

it("Tab 填入 /model 并留参数位，不直接发送", async () => {
  await render();
  await type("/mo");
  await key("Tab");
  expect((area() as HTMLTextAreaElement).value).toBe("/model ");
  expect(onSend).not.toHaveBeenCalled();
  // 填入后面板让位（在写参数，方向键归输入框）
  expect(panelText()).toBe("");
});

it("完整 /compact 上回车直接发送", async () => {
  await render();
  await type("/compact");
  await key("Enter");
  // 第二个参数是附件（这里没有图 ⇒ 空数组）。
  expect(onSend).toHaveBeenCalledWith("/compact", []);
  expect((area() as HTMLTextAreaElement).value).toBe("");
});

it("白名单命令带参数原样转发", async () => {
  await render();
  await type("/model opus");
  await clickSend();
  expect(onSend).toHaveBeenCalledWith("/model opus", []);
});

it("未知命令被闸门拦住：不发送、给提示、不清空输入", async () => {
  await render();
  await type("/foo");
  await clickSend();
  expect(onSend).not.toHaveBeenCalled();
  expect(container.textContent).toContain("未发送");
  expect(container.textContent).toContain("/foo");
  // 输入留着让用户改，提示一打字就清
  expect((area() as HTMLTextAreaElement).value).toBe("/foo");
  await type("/foo!");
  expect(container.textContent).not.toContain("未发送");
});

it("Esc 关闭面板，继续打字不重新弹出直到值变化", async () => {
  await render();
  await type("/");
  expect(panelText()).toContain("/compact");
  await key("Escape");
  expect(panelText()).toBe("");
});

it("Ctrl+Enter 照旧发送普通文本", async () => {
  await render();
  await type("帮我看下这个 bug");
  await key("Enter", { ctrlKey: true });
  expect(onSend).toHaveBeenCalledWith("帮我看下这个 bug", []);
});

/// 默认发送键是 Enter（主流），换行留给 Shift+Enter。旧实现写死 Ctrl+Enter 且没有
/// 设置入口，而「回车打出一句半截的话」是每天都会发生的事。
it("默认 Enter 发送；Shift+Enter 只换行、不发", async () => {
  await render();
  await type("你好");
  expect(panelText()).toBe("");
  await key("Enter", { shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  await key("Enter");
  expect(onSend).toHaveBeenCalledWith("你好", []);
});

/// 老习惯的人会按 Ctrl+Enter：两档都能发，不冲突（Ctrl+Enter 不含 Shift）。
it("Ctrl+Enter 在默认档下也发送", async () => {
  await render();
  await type("再来一句");
  await key("Enter", { ctrlKey: true });
  expect(onSend).toHaveBeenCalledWith("再来一句", []);
});

/* ── @引用补全（设计稿《对话页-@引用与排版偏好》）── */

it("打出 @ 浮出引用面板：本会话目录置顶 + 白名单根", async () => {
  await render();
  await type("@");
  await flush();
  expect(mentionText()).toContain("本会话目录");
  expect(mentionText()).toContain("work");
  expect(mentionText()).toContain("proj");
  // 邮箱形态（@ 前是非空白）不弹
  await type("user@hos");
  expect(mentionText()).toBe("");
});

it("选中目录续写路径并下钻，选中文件插入并收尾", async () => {
  await render();
  await type("@");
  await flush();
  // 第一项是置顶的会话目录，Enter = 续写 @D:\work/ 并自动列出下一层
  await key("Enter");
  expect((area() as HTMLTextAreaElement).value).toBe("@D:\\work/");
  await flush();
  expect(mentionText()).toContain("src");
  expect(mentionText()).toContain("readme.md");
  // 过滤剩文件，Enter = 插入 + 尾随空格（token 结束，面板收起）
  await type("@D:\\work/readme");
  await flush();
  expect(mentionText()).toContain("readme.md");
  expect(mentionText()).not.toContain("src");
  await key("Enter");
  expect((area() as HTMLTextAreaElement).value).toBe("@D:\\work\\readme.md ");
  expect(mentionText()).toBe("");
});

it("Esc 关闭引用面板，a@b 形态不误伤普通输入", async () => {
  await render();
  await type("@");
  await flush();
  expect(mentionText()).not.toBe("");
  await key("Escape");
  expect(mentionText()).toBe("");
});

/// 发送 IPC 在途（onSend 还没返回）时再点发送 / 按住 Ctrl+Enter：不能把同一条再提交一次，
/// 否则第二次会被当成「运行中」排进队列，本轮结束后同一句话自动再发一遍。
it("发送在途时重复触发只提交一次，返回后清空输入", async () => {
  let resolveSend: (v: boolean) => void = () => {};
  onSend.mockImplementation(() => new Promise<boolean>((r) => (resolveSend = r)));
  await render();
  await type("你好");
  await clickSend();
  await clickSend();
  await key("Enter", { ctrlKey: true });
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(area().value).toBe("你好");
  await act(async () => resolveSend(true));
  expect(area().value).toBe("");
});

/// 发送失败（onSend 返回 false）要把锁放开：草稿留着，用户改完能再发。
it("发送失败后草稿保留且可再次发送", async () => {
  onSend.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await render();
  await type("重试我");
  await clickSend();
  expect(area().value).toBe("重试我");
  await clickSend();
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(area().value).toBe("");
});

it("点击发送立即回到输入框，可连续准备下一条而不重复提交", async () => {
  let resolveSend!: (accepted: boolean) => void;
  onSend.mockImplementation(() => new Promise<boolean>(resolve => { resolveSend = resolve; }));
  await render(); await type("第一条");
  await clickSend();
  expect(document.activeElement).toBe(area());
  await type("继续写下一条");
  await act(async () => resolveSend(true));
  expect(area().value).toBe("继续写下一条");
  expect(onSend).toHaveBeenCalledTimes(1);
});

/// 空状态点示例 prompt：填进草稿并聚焦（不直接发送），用户可改后再发；同一句连点两次（nonce 变）也要重填。
it("prefill 填入草稿并聚焦，不触发发送", async () => {
  const mount = (prefill: { text: string; nonce: number }) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <Composer
            onSend={onSend}
            queueCount={0}
            onClearQueue={() => {}}
            mentionSource={{ connectionId: "", cwd: "D:\\work" }}
            prefill={prefill}
            draftKey="test-pane"
          />
        </QueryClientProvider>,
      );
    });
  await mount({ text: "跑一下测试", nonce: 1 });
  expect(area().value).toBe("跑一下测试");
  expect(document.activeElement).toBe(area());
  expect(onSend).not.toHaveBeenCalled();

  await type("我改过了");
  await mount({ text: "跑一下测试", nonce: 2 });
  expect(area().value).toBe("跑一下测试");
});
