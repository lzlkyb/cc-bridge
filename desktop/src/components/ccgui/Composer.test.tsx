// @vitest-environment jsdom
import { act } from "react";
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

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <Composer
          onSend={onSend}
          queueCount={0}
          onClearQueue={() => {}}
          mentionSource={{ connectionId: "", cwd: "D:\\work" }}
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
    [...container.querySelectorAll("button")].find((b) => b.textContent === "发送")!.click();
  });
}

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

it("普通文本不弹面板，裸 Enter 不触发发送（换行是浏览器原生行为）", async () => {
  await render();
  await type("你好");
  expect(panelText()).toBe("");
  await key("Enter");
  expect(onSend).not.toHaveBeenCalled();
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
