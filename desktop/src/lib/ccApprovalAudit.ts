/**
 * 审批即审计（批 4-2）：把「我点过的每一个允许」和「它实际改了什么」对上。
 *
 * ## 为什么不是复用 `ccChangeset`
 *
 * 那个模块回答「这个会话改过哪些文件」，按**文件**聚合，一个文件一行。
 * 这里回答的是另一个问题：**哪一次点头导致了哪一处改动，能不能撤回**。
 * 同一个文件被改三次，在那边是一行 ×3，在这边是三个点、三个独立的撤销。
 *
 * ## 两条数据源，各管一半
 *
 * ```text
 * 会话事件流（参数 messages + resolved）→ 审批点、工具、入参、diff
 * 审计备份（参数 backups，后端 cc_session_backups）→ 能不能还原
 * ```
 *
 * 关联键：`approval.toolUseId` === `CcMessage(kind:"tool").id`。这是协议里
 * 原样带下来的 `tool_use_id`，不是按时间猜的。
 *
 * ## 三个必须如实处理的现实
 *
 * 1. **内置工具没有备份**。CC 的 Edit / Write 不走 MCP 桥，审计里没有它们的条目。
 *    Edit 型还能靠 `old_string`/`new_string` 反向应用；Write 覆盖了已有文件就真的
 *    没有回头路（它只给新内容，旧内容从来没到过我们手上）。
 * 2. **桥的批量写只留最后一个备份**。`write_files` 一次可写多个文件，而审计的
 *    `backupPath` 是单个槽位（`record_op_backup`）。所以一次写 N 个文件只有 1 个可还原，
 *    其余必须标清楚，不能假装。
 * 3. **历史会话没有审批事件**。审批是交互协议，CLI 的 `.jsonl` 转录里根本不落它。
 *    所以从历史打开的会话只能显示「改了什么」，`decision` 是 `unknown`。
 */

import { computeLineDiff } from "./ccDiff";
import { readPath, shortPath } from "./ccChangeset";
import type { CcMessage } from "./ccGuiTypes";
import { asString, editPair } from "../components/ccgui/summarize";

/** 审计里带备份的一条（后端 `cc_session_backups` 的返回项）。 */
export type CcSessionBackup = {
  tool: string;
  targetPath: string;
  backupPath: string;
  timestamp: string;
};

/** 撤销这次改动的手段。`none` 之外都要能真的执行。 */
export type RevertKind = "backup" | "patch" | "delete-created" | "none";

/** 谁决定了这次调用。`unknown` = 历史重放（转录里没有审批事件）。 */
export type ApprovalDecision = "allow" | "deny" | "pending" | "unknown";

export type EditPatch = { oldString: string; newString: string };

export type ApprovalFileChange = {
  /** 入参里的原样路径（可能是相对的）。 */
  path: string;
  /** 展示用短名（路径后两段）。 */
  label: string;
  added: number;
  removed: number;
  /** 本会话里第一次动它就是 Write ⇒ 可能是新建。 */
  created: boolean;
  revert: RevertKind;
  /** `revert === "none"` 时必有：为什么撤不了。 */
  reason?: string;
  /** `revert === "backup"` 时：审计里那份快照。 */
  backupPath?: string;
  /** `revert === "patch"` 时：反向应用这几处（**按原顺序**，执行时从后往前）。 */
  patches?: EditPatch[];
  /**
   * `revert === "delete-created"` 时：当时写进去的内容。
   *
   * 删除前要拿它跟文件当前内容逐字节比对 —— 已经被人改过的文件不许删
   * （见后端 `restore_delete_created`）。这是「判错就删用户文件」的第二道闸。
   */
  writtenContent?: string;
};

export type ApprovalPoint = {
  /** 稳定 key：优先 toolUseId，没有就用审批的 requestId。 */
  key: string;
  toolName: string;
  decision: ApprovalDecision;
  /** 规则自动放行（不是用户点的）。 */
  auto: boolean;
  files: ApprovalFileChange[];
  /** 跳转到流里那条消息（tool 消息的 id 就是 toolUseId）。 */
  jumpId: string | null;
  /** 点级备注：拒绝、未决、或「已允许但没找到调用记录」。 */
  note?: string;
};

export type ApprovalGroup = {
  /** 第几轮：每遇到一条用户消息 +1，从 1 起。 */
  turn: number;
  points: ApprovalPoint[];
};

/** CC 内置的编辑型工具：不走桥、无备份，但入参带 old/new 可反向应用。 */
const BUILTIN_EDIT = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
/** CC 内置的整文件写入：不走桥、无备份，且**没有旧内容**。 */
const BUILTIN_WRITE = new Set(["Write"]);
/** 走桥的写工具：审计里有 backupPath（批量写只留最后一个）。 */
const BRIDGE_WRITE = new Set([
  "write_files",
  "edit_files",
  "delete_files",
  "move_files",
  "copy_files",
  "create_directory",
  "remove_directory",
  "notebook_edit",
]);

function isFileWriter(tool: string): boolean {
  return BUILTIN_EDIT.has(tool) || BUILTIN_WRITE.has(tool) || BRIDGE_WRITE.has(tool);
}

/** 绝对路径判定：Windows 盘符 / UNC / POSIX 根。 */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:\//.test(p) || p.startsWith("//") || p.startsWith("/");
}

/**
 * 路径归一，用于跨数据源比对。
 *
 * 事件流里的 `path` 可能是相对的（相对 CC 的工作目录），而审计里的 `targetPath`
 * 是写工具解析后的绝对路径。所以：相对路径先拼 `cwd`，再统一分隔符与大小写。
 *
 * 盘符式路径按小写比：Windows 文件系统本身大小写不敏感，`C:\Src` 与 `c:\src`
 * 是同一个文件。POSIX 路径不动大小写（那边是敏感的）。
 */
export function pathKey(raw: string, cwd: string | null): string {
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return "";
  if (!isAbsolutePath(p) && cwd) {
    p = `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${p}`;
  }
  // 折叠 `//`、`/./`、开头的 `./`、结尾斜杠 —— 只为比较，不追求成为合法的规范化路径。
  p = p
    .replace(/\/{2,}/g, "/")
    .replace(/\/\.\//g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
}

/** 一处改动的 ± 行数。Write 的旧侧恒为空（新建文件的实际形态）。 */
function diffStat(tool: string, input: Record<string, unknown>): { added: number; removed: number } {
  const pair = tool === "Write" ? { oldText: "", newText: asString(input.content) } : editPair(input);
  if (!pair) return { added: 0, removed: 0 };
  const d = computeLineDiff(pair.oldText, pair.newText);
  return { added: d.added, removed: d.removed };
}

/**
 * 一次调用改了哪些文件。
 *
 * 桥的 `write_files` 是多文件入参（`files: [{path, content}]`），其余都是单文件。
 * 返回空数组表示「这个工具没有改文件」（Bash / Read / 搜索…）。
 */
function filesOf(tool: string, input: Record<string, unknown>): string[] {
  if (tool === "write_files") {
    const list = input.files;
    if (Array.isArray(list)) {
      return list
        .map((f) => readPath((f ?? {}) as Record<string, unknown>))
        .filter((p) => p !== "");
    }
  }
  const one = readPath(input);
  return one ? [one] : [];
}

/**
 * 备份池：一次扫描、逐个消费。
 *
 * `used` 保证同一份备份不会被两个改动点认领（两处都显示「可撤销」、点第二个必失败，
 * 是最难查的一类 bug）。认领顺序按事件流顺序 ⇒ 天然对上发生顺序。
 */
type PooledBackup = CcSessionBackup & { used: boolean };

function newPool(backups: CcSessionBackup[]): PooledBackup[] {
  return backups.map((b) => ({ ...b, used: false }));
}

function takeBackup(
  pool: PooledBackup[],
  tool: string,
  path: string,
  cwd: string | null,
): PooledBackup | null {
  const want = pathKey(path, cwd);
  if (!want) return null;
  const hit = pool.find(
    (b) => !b.used && b.tool === tool && pathKey(b.targetPath, cwd) === want,
  );
  if (hit) hit.used = true;
  return hit ?? null;
}

/**
 * CC 内置 Write 成功时回的是「File created successfully at: …」或
 * 「The file … has been updated」。**只有明确说创建了**才敢把「删掉它」当作还原手段——
 * 判反了就是删用户原有文件，那是比撤不回来严重得多的伤害。
 *
 * 文案匹配不上时返回 `null`（无法确认），不是 `false`（覆盖）：两者对用户
 * 要说的话不一样，代码里也不该混。
 */
const CREATED_HINT = /created successfully|file created/i;
/** 反向证据：明确说更新了，就是**确认覆盖**，措辞要和「判不出来」分开。 */
const UPDATED_HINT = /has been updated|updated successfully/i;

function resultSaysCreated(result: string | undefined): boolean | null {
  const s = typeof result === "string" ? result : "";
  if (CREATED_HINT.test(s)) return true;
  if (UPDATED_HINT.test(s)) return false;
  return null;
}

/** Edit / MultiEdit 的入参 → 补丁列表（按执行顺序；单次与批量两种形状统一到这里）。 */
function editPatches(input: Record<string, unknown>): EditPatch[] {
  const raw = input.edits;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      return { oldString: asString(o.old_string), newString: asString(o.new_string) };
    });
  }
  return [{ oldString: asString(input.old_string), newString: asString(input.new_string) }];
}

/**
 * 展示用内容：把「改动前 / 改动后」的原文带出去，面板就地展开看真 diff。
 *
 * 🔴 与 `classify` 分开是有意的：**能不能撤销**（`revert`）和**能不能看**（内容）
 *    是两件事。混在一条链路里会让「撤不了」看起来像「也看不到」——而事实恰恰相反：
 *    内置 Edit 撤不了的情况（入参残缺）仍然有原文可看。
 *
 * `index` 只对桥的批量写有意义（`files: [{path, content}]` 按入参顺序对齐）。
 * 显式 `base64` 编码的写入不带内容：那是二进制，按文本展示只会是乱码。
 */
function contentOf(
  tool: string,
  input: Record<string, unknown>,
  index: number,
): Pick<ApprovalFileChange, "patches" | "writtenContent"> {
  if (BUILTIN_EDIT.has(tool)) {
    const patches = editPatches(input);
    return patches.some((p) => p.oldString || p.newString) ? { patches } : {};
  }
  if (BUILTIN_WRITE.has(tool)) {
    const content = asString(input.content);
    return content ? { writtenContent: content } : {};
  }
  if (tool === "write_files") {
    const list = input.files;
    const one = Array.isArray(list) ? (list[index] as Record<string, unknown> | undefined) : undefined;
    if (asString(one?.encoding) === "base64") return {};
    const content = asString(one?.content);
    return content ? { writtenContent: content } : {};
  }
  return {};
}

/** 判定一个文件的可还原手段 + 落好要用的数据。 */
function classify(
  tool: string,
  input: Record<string, unknown>,
  /** `true` 确认新建 / `false` 确认覆盖 / `null` 无法确认。 */
  created: boolean | null,
  backup: PooledBackup | null,
): Pick<ApprovalFileChange, "revert" | "reason" | "backupPath" | "patches" | "writtenContent"> {
  if (backup) {
    return { revert: "backup", backupPath: backup.backupPath };
  }
  if (BUILTIN_EDIT.has(tool)) {
    const patches = editPatches(input);
    // 有一侧是空的就没法反向拼回去（Write 形态的 Edit、或入参残缺）。
    if (patches.every((p) => p.newString !== "") && patches.some((p) => p.oldString !== "")) {
      return { revert: "patch", patches };
    }
    return {
      revert: "none",
      reason: "这次编辑没有可反向恢复的原文（只有新内容），也没有备份。",
    };
  }
  if (BUILTIN_WRITE.has(tool)) {
    if (created === true) {
      return { revert: "delete-created", writtenContent: asString(input.content) };
    }
    if (created === false) {
      return {
        revert: "none",
        reason: "内置 Write 覆盖了已有文件：它只给新内容，旧内容从来没经过我们，没有备份也没有补丁。",
      };
    }
    return {
      revert: "none",
      reason: "内置 Write 没有备份，也确认不了这个文件是本次新建的 —— 能确认才敢用「删掉它」来还原。",
    };
  }
  // 桥的写工具但没认到备份：要么同一次批量写只留了最后一个，要么审计不在本会话范围。
  return {
    revert: "none",
    reason:
      "这次写入没在审计里留下备份（批量写只保留最后一个；历史会话也查不到当时的审计）。",
  };
}

/**
 * 主入口。
 *
 * `resolved` 是 `CcView.resolved`（requestId → 裁决），`backups` 来自后端，
 * `cwd` 用来把相对路径补成绝对路径（缺失时只做分隔符/大小写归一）。
 */
export function buildApprovalAudit(
  messages: CcMessage[],
  resolved: Record<string, { decision: "allow" | "deny"; auto?: boolean }>,
  backups: CcSessionBackup[],
  cwd: string | null,
): ApprovalGroup[] {
  // toolUseId → 审批（一个工具调用最多一次审批）
  const byToolUse = new Map<string, { requestId: string; decision: "allow" | "deny" | "pending"; auto: boolean }>();
  for (const m of messages) {
    if (m.kind !== "approval" || !m.toolUseId) continue;
    const r = resolved[m.id];
    byToolUse.set(m.toolUseId, {
      requestId: m.id,
      decision: r ? r.decision : "pending",
      auto: r?.auto === true,
    });
  }

  const pool = newPool(backups);
  /** 已被某个 tool 消息消费掉的审批（避免同一次调用出两个点）。 */
  const consumed = new Set<string>();
  /** 本会话里第一次见到某路径时是不是 Write ⇒ 新建。 */
  const firstSeenAsWrite = new Map<string, boolean>();

  const groups: ApprovalGroup[] = [];
  let turn = 0;
  let current: ApprovalPoint[] = [];
  const flush = () => {
    if (current.length > 0) groups.push({ turn, points: current });
    current = [];
  };

  for (const m of messages) {
    if (m.kind === "user") {
      // 一条用户消息开启新一轮。turn 从 1 起：第一轮之前不会有改动。
      flush();
      turn += 1;
      continue;
    }

    if (m.kind === "approval") {
      const r = resolved[m.id];
      const decision: ApprovalDecision = r ? r.decision : "pending";
      // 已允许且有 toolUseId 的：等它的 tool 消息来生成点（那里才有入参和文件）。
      if (decision === "allow" && m.toolUseId && byToolUse.has(m.toolUseId)) continue;
      if (decision === "deny") {
        current.push({
          key: m.id,
          toolName: m.toolName,
          decision: "deny",
          auto: r?.auto === true,
          files: [],
          jumpId: m.id,
          note: "已拒绝，这次调用没有执行。",
        });
        continue;
      }
      // 未决 / 已允许但找不到调用记录：也给一个点，信息量为「我点过它」。
      current.push({
        key: m.id,
        toolName: m.toolName,
        decision,
        auto: r?.auto === true,
        files: [],
        jumpId: m.id,
        note: decision === "pending" ? "还在等你决定。" : "已允许，但流水里没有它的调用记录。",
      });
      continue;
    }

    if (m.kind !== "tool") continue;
    const tool = m.tool;
    if (!isFileWriter(tool.name)) continue;

    const approval = byToolUse.get(tool.id);
    const paths = filesOf(tool.name, tool.input);
    if (paths.length === 0) continue;

    const stat = diffStat(tool.name, tool.input);
    const files: ApprovalFileChange[] = paths.map((path, i) => {
      const backup = takeBackup(pool, tool.name, path, cwd);
      const key = pathKey(path, cwd);
      // 「新建」需要两个证据同时成立：本会话里第一次动它，**且**工具结果明说创建了。
      // 只看前者会把「覆盖一个从没聊过的老文件」误判成新建 —— 那样给出的撤销
      // 就是删除用户的原有文件。
      const firstTime = !firstSeenAsWrite.has(key);
      if (firstTime) firstSeenAsWrite.set(key, tool.name === "Write");
      const created: boolean | null =
        tool.name !== "Write" || !firstTime ? false : resultSaysCreated(tool.result);
      const cls = classify(tool.name, tool.input, created, backup);
      return {
        path,
        label: shortPath(path),
        // 批量写的 ± 只对第一个文件有意义（入参里那份 content 是它的）。
        added: i === 0 ? stat.added : 0,
        removed: i === 0 ? stat.removed : 0,
        created: created === true,
        ...cls,
        // 展示内容放最后：撤销分支里那份可能因为条件不齐而缺席，这里补齐。
        ...contentOf(tool.name, tool.input, i),
      };
    });

    if (approval) consumed.add(approval.requestId);
    current.push({
      key: tool.id,
      toolName: tool.name,
      decision: approval ? approval.decision : "unknown",
      auto: approval?.auto === true,
      files,
      jumpId: tool.id,
    });
  }
  flush();

  return groups;
}

/** 面板头部的汇总。`revertable` 数的是**文件**（一个点可能改多个文件）。 */
export function approvalStat(groups: ApprovalGroup[]): {
  points: number;
  files: number;
  revertable: number;
  denied: number;
} {
  let points = 0;
  let files = 0;
  let revertable = 0;
  let denied = 0;
  for (const g of groups) {
    for (const p of g.points) {
      points += 1;
      if (p.decision === "deny") denied += 1;
      for (const f of p.files) {
        files += 1;
        if (f.revert !== "none") revertable += 1;
      }
    }
  }
  return { points, files, revertable, denied };
}

/** 这一组里能整组撤销的文件（组头按钮的依据）。 */
export function revertableFiles(point: ApprovalPoint): ApprovalFileChange[] {
  return point.files.filter((f) => f.revert !== "none");
}
