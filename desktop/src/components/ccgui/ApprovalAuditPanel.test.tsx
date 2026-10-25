// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalAuditPanel } from "./ApprovalAuditPanel";
import { revertKey } from "../../hooks/useCcApprovalAudit";
import { approvalStat, type ApprovalFileChange, type ApprovalGroup, type ApprovalPoint } from "../../lib/ccApprovalAudit";

/**
 * 锁面板的对外行为：**分组 + 三个动作**
 * （点行跳转、单点撤销、整组撤销）+ 收起来的两种方式。
 *
 * 「什么能撤销、为什么不能」的判定正确性在 `ccApprovalAudit.test.ts` 里，
 * 这里只验「判定结果被如实摆出来」—— 判对了却渲染成同一个样子，等于没判。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;

const groups: ApprovalGroup[] = [
  {
    turn: 1,
    points: [
      {
        key: "tu_1",
        toolName: "Edit",
        decision: "allow",
        auto: false,
        jumpId: "tu_1",
        files: [
          {
            path: "/repo/src/a.ts",
            label: "src/a.ts",
            added: 3,
            removed: 1,
            created: false,
            revert: "patch",
            patches: [{ oldString: "a", newString: "b" }],
          },
        ],
      },
      {
        key: "tu_2",
        toolName: "Write",
        decision: "allow",
        auto: true,
        jumpId: "tu_2",
        files: [
          {
            path: "/repo/src/new.ts",
            label: "src/new.ts",
            added: 5,
            removed: 0,
            created: true,
            revert: "none",
            reason: "内置 Write 没有备份，也确认不了这个文件是本次新建的。",
          },
        ],
      },
    ],
  },
  {
    turn: 2,
    points: [
      {
        key: "req_9",
        toolName: "Bash",
        decision: "deny",
        auto: false,
        files: [],
        jumpId: "req_9",
        note: "已拒绝，这次调用没有执行。",
      },
    ],
  },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type Handlers = {
  onRevertOne: ReturnType<typeof vi.fn<(p: ApprovalPoint, f: ApprovalFileChange) => void>>;
  onRevertGroup: ReturnType<typeof vi.fn<(g: ApprovalGroup) => void>>;
  onJump: ReturnType<typeof vi.fn<(id: string) => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
};

async function render(
  opts: { groups?: ApprovalGroup[]; reverted?: Record<string, true>; busyKey?: string | null } = {},
): Promise<Handlers> {
  const h: Handlers = {
    onRevertOne: vi.fn<(p: ApprovalPoint, f: ApprovalFileChange) => void>(),
    onRevertGroup: vi.fn<(g: ApprovalGroup) => void>(),
    onJump: vi.fn<(id: string) => void>(),
    onClose: vi.fn<() => void>(),
  };
  const list = opts.groups ?? groups;
  await act(async () => {
    root.render(
      <ApprovalAuditPanel
        groups={list}
        stat={approvalStat(list)}
        reverted={opts.reverted ?? {}}
        busyKey={opts.busyKey ?? null}
        onRevertOne={h.onRevertOne}
        onRevertGroup={h.onRevertGroup}
        onJump={h.onJump}
        onClose={h.onClose}
      />,
    );
  });
  return h;
}

/** 按 tooltip 前缀找行内跳转按钮（路径是唯一的）。 */
function rowButton(path: string): HTMLButtonElement {
  const hit = [...container.querySelectorAll("button")].find((b) =>
    b.getAttribute("title")?.startsWith(path),
  );
  if (!hit) throw new Error(`找不到 ${path} 的行`);
  return hit;
}
/** 文字**完全等于**才命中：组头是「整组撤销」，行内是「撤销」，`includes` 会串。 */
function buttons(exact: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === exact,
  );
}
function groupHeader(turn: number): HTMLElement {
  const hit = [...container.querySelectorAll("div")].find((d) =>
    d.className.includes("bg-muted/45") && d.textContent?.includes(`第 ${turn} 轮`),
  );
  if (!hit) throw new Error(`找不到第 ${turn} 轮的组头`);
  return hit as HTMLElement;
}

it("按轮分组成树、头部给汇总、行上给 ± 与新建徽章", async () => {
  await render();
  const text = container.textContent ?? "";
  expect(text).toContain("3 个审批点 · 2 个文件 · 1 个可撤销");
  expect(text).toContain("第 1 轮");
  expect(text).toContain("第 2 轮");
  // 组头数的是**点**，不是文件。
  expect(groupHeader(1).textContent).toContain("2 个审批点");
  expect(groupHeader(2).textContent).toContain("1 个审批点");

  expect(rowButton("/repo/src/a.ts").textContent).toContain("src/a.ts");
  expect(rowButton("/repo/src/a.ts").textContent).toContain("+3");
  expect(rowButton("/repo/src/a.ts").textContent).toContain("−1");
  expect(rowButton("/repo/src/new.ts").textContent).toContain("新建");
});

it("点行把该审批点的跳转 id 交出去", async () => {
  const { onJump } = await render();
  await act(async () => rowButton("/repo/src/a.ts").click());
  expect(onJump).toHaveBeenCalledWith("tu_1");
  await act(async () => rowButton("/repo/src/new.ts").click());
  expect(onJump).toHaveBeenCalledWith("tu_2");
});

it("可撤销的行有撤销按钮，点了把「点 + 文件」一起交给上层", async () => {
  const { onRevertOne, onJump } = await render();
  const revert = buttons("撤销");
  expect(revert).toHaveLength(1);
  await act(async () => revert[0].click());
  // 撤销不该顺手把用户跳到别处去。
  expect(onJump).not.toHaveBeenCalled();
  expect(onRevertOne).toHaveBeenCalledOnce();
  const [point, file] = onRevertOne.mock.calls[0];
  expect(point.key).toBe("tu_1");
  expect(file.path).toBe("/repo/src/a.ts");
});

it("不可撤销的行不给按钮，但必须写明为什么", async () => {
  await render();
  // 只有 src/a.ts 那条有撤销按钮；src/new.ts 那条换成「不可撤销」。
  expect(buttons("撤销")).toHaveLength(1);
  expect(container.textContent).toContain("不可撤销");
  expect(container.textContent).toContain("内置 Write 没有备份，也确认不了这个文件是本次新建的。");
  // 只有两段可点击区域：两个文件的跳转按钮 + 两个组头 + 关闭 + 一个撤销。
  expect(rowButton("/repo/src/new.ts").closest("div")?.textContent).toContain("不可撤销");
});

it("已撤销的行换成结果文案，且不再给按钮", async () => {
  await render({ reverted: { [revertKey("tu_1", "/repo/src/a.ts")]: true } });
  expect(buttons("撤销")).toHaveLength(0);
  expect(container.textContent).toContain("已撤销");
});

it("正在撤销的那条按钮置灰（防同一条并发点两下）", async () => {
  await render({ busyKey: revertKey("tu_1", "/repo/src/a.ts") });
  const revert = buttons("撤销");
  expect(revert).toHaveLength(1);
  expect(revert[0].disabled).toBe(true);
});

it("整组撤销：可撤销时交出去，组内没有可撤销项时置灰", async () => {
  const { onRevertGroup } = await render();
  const heads = buttons("整组撤销");
  expect(heads).toHaveLength(2);
  // 第 2 轮只有一个「已拒绝」，没有文件可撤。
  expect(heads[0].disabled).toBe(false);
  expect(heads[1].disabled).toBe(true);
  await act(async () => heads[0].click());
  expect(onRevertGroup).toHaveBeenCalledWith(groups[0]);
});

it("整组撤销在有单条正在跑时置灰（串行，不许两个撤销同时动同一个文件）", async () => {
  await render({ busyKey: revertKey("tu_1", "/repo/src/a.ts") });
  for (const b of buttons("整组撤销")) expect(b.disabled).toBe(true);
});

it("被拒绝的调用只有一行，写清「没有执行」", async () => {
  const { onJump } = await render();
  const body = groupHeader(2).parentElement?.textContent ?? "";
  expect(body).toContain("Bash");
  expect(body).toContain("已拒绝，这次调用没有执行。");
  // 没有文件就没有行内跳转按钮：这一行的工具名不是可点的。
  expect([...groupHeader(2).parentElement!.querySelectorAll("button")]).toHaveLength(1);
  expect(onJump).not.toHaveBeenCalled();
});

it("Esc 与点外面都能收起", async () => {
  const { onClose } = await render();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("点面板自己不算点外面", async () => {
  const { onClose } = await render();
  await act(async () => {
    rowButton("/repo/src/a.ts").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(onClose).not.toHaveBeenCalled();
});

it("没有改动时给的是引导而不是空列表", async () => {
  await render({ groups: [] });
  expect(container.textContent).toContain("这一会话还没有改过文件");
  expect(container.textContent).toContain("Edit / Write");
});
