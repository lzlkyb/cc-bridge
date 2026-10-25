/**
 * CC 对话页的本地偏好：权限模式 + 每台机器各自的工作目录 + 模型选择。
 *
 * 为什么单独一个文件：这几样都只活在 localStorage 里（后端配置里没有），
 * 读写规则又带几个条件（四个合法模式、本机键名不能为空串），
 * 混在页面组件里既占体量门禁的额度，又让「哪些东西是持久化的」变得难查。
 *
 * 🔴 为什么工作目录要**按连接分开存**：本机的 `D:\proj` 喂给远端只会得到
 * 一句看不懂的报错；同一台远端上不同项目也要各记各的。键里带 connectionId，
 * 本机用 `local`（空串做键名后缀在排查时会看起来像 bug）。
 *
 * 模型是**全局**的（不按连接分）：换机器时保持同一个模型是大多数人的预期，
 * 真要按项目切模型的人会用 `/model` 或恢复会话时自动带回它自己的模型。
 */
import type { CcPermissionMode } from "./ccGuiTypes";

const MODE_KEY = "cc-bridge.ccgui.mode";
const MODEL_KEY = "cc-bridge.ccgui.model";

const cwdKey = (target: string) => `cc-bridge.ccgui.cwd.${target || "local"}`;

/** 只认四个合法模式。来源可能是 localStorage，也可能是库里的旧值。 */
export function asMode(raw: string | null | undefined): CcPermissionMode | null {
  return raw === "plan" || raw === "default" || raw === "acceptEdits" || raw === "bypassPermissions"
    ? raw
    : null;
}

export function readMode(): CcPermissionMode {
  return asMode(localStorage.getItem(MODE_KEY)) ?? "default";
}

export function saveMode(mode: CcPermissionMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

/** 空串 = 不传 `--model`，吃 CLI 自己的默认（可能是用户 settings 里设的那个）。 */
export function readModel(): string {
  return (localStorage.getItem(MODEL_KEY) ?? "").trim();
}

export function saveModel(model: string): void {
  const v = model.trim();
  if (v) localStorage.setItem(MODEL_KEY, v);
  else localStorage.removeItem(MODEL_KEY);
}

export function readCwd(target: string): string {
  return localStorage.getItem(cwdKey(target)) ?? "";
}

export function saveCwd(target: string, cwd: string): void {
  localStorage.setItem(cwdKey(target), cwd);
}

/**
 * 恢复出来的会话 → 这一页要写回去的目标与偏好。**纯计算**，不动 localStorage。
 *
 * 为什么值得单独一个函数：这四样东西的写入顺序有讲究（`saveCwd` 必须在
 * `setTargetId` 之前，否则被 `targetId` 的 effect 用旧键重读覆盖），而
 * 「哪些字段缺席时不许覆盖用户当前选择」也有明确口径（模型为空串时不动）。
 * 把这段判断摊在组件的 effect 里，多会话后每个 pane 都要再解释一遍。
 *
 * `mode` / `model` 为 `null` 表示「库里没记 / 值不合法」，调用方**不要动**
 * 当前选择 —— 拿空值覆盖用户刚设的东西，等于替用户改设置。
 */
export function restorePlan(row: {
  connectionId: string;
  cwd?: string | null;
  permissionMode?: string | null;
  model?: string | null;
}): {
  connectionId: string;
  cwd: string;
  mode: CcPermissionMode | null;
  model: string | null;
} {
  return {
    connectionId: row.connectionId,
    cwd: row.cwd ?? "",
    mode: asMode(row.permissionMode),
    model: row.model && row.model.trim() ? row.model.trim() : null,
  };
}
