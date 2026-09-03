#!/usr/bin/env node
/**
 * 组件体量门禁（规则 7 的机器执行版）。
 *
 * 为什么要写这个（2026-09-02）：“单个 .tsx 禁止超过 300 行”写在 CLAUDE.md 里，
 * 但**没有任何东西执行**，于是：
 *   - 实际有 5 个文件超标（最大 575 行），而豁免名单只登记了 1 个且行数已过期；
 *   - 它只在“有人恰好想起来”时生效，等于靠运气执行。
 *
 * 两个指标，缺一不可：
 *
 * 1. **行数**，且同时管 `.tsx` 与 `.ts`。只管 `.tsx` 的话，复杂度会直接搬家到 hooks 里
 *    躲计数器——本仓库就有现成例子：`useSshTransfer.ts` 345 行，是整个终端功能里
 *    最危险的代码（凭据填充、覆盖确认、取消语义），却因为扩展名是 `.ts` 而豁免。
 *
 * 2. **单个文件里的 `useState` + `useEffect` 总数**。这个比行数准：
 *    100 行 JSX 与 100 行异步状态逻辑的阅读成本差一个数量级。真实事故：
 *    `SshFileBrowser` 曾有 10 个 useState + 4 个 useEffect，新加的一个回写 effect
 *    撞上“切连接时组件不重挂”，把 A 连接的目录存成了 B 的。300 行那条线拦不住它。
 *
 * 采用**棘轮（ratchet）**而不是一刀切：存量超标文件记在下面的 BASELINE 里，
 * **只允许变小不允许变大**；新文件必须直接合规。否则要么得先做一次大重构才能启用，
 * 要么又变成一条没人执行的规则。修小了记得把 BASELINE 里的数字一起调低（脚本会提醒）。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN_DIRS = ["src/components", "src/hooks"];

const MAX_LINES = 300;
const MAX_HOOKS = 8;

/**
 * 存量超标登记（棘轮基线）。键 = 仓库相对路径（POSIX 分隔符）。
 * `lines` / `hooks` 是**当前允许的上限**，不是目标值。目标永远是上面两个常量。
 */
const BASELINE = {
  // ── 行数超标 ──
  "src/components/backup/VersionHistoryModal.tsx": { lines: 575, hooks: 11 },
  "src/components/tabs/LogTab.tsx": { lines: 509, hooks: 11 },
  "src/components/tabs/ConnectTab.tsx": { lines: 502, hooks: 13 },
  "src/components/tabs/AboutGroup.tsx": { lines: 475 },
  // 🔴 514 行，而且是 2026-09-02 本次重构**新建**的。当时把 621 行的
  // `SshTerminal.tsx` 拆成 115 行 + 这个 hook，并声称“符合规则 7”——
  // 那只是因为当时的规则只管 `.tsx`。这正是本脚本要堵的“搬家”。
  // 2026-09-03：513 → 443（快捷键钩子→terminalKeymap.ts，粘贴→useTerminalPaste.ts）。
  "src/components/tabs/useSshTerminalSession.ts": { lines: 443 },
  "src/components/tabs/PerfCharts.tsx": { lines: 401 },
  "src/components/tabs/LogDetailPanel.tsx": { lines: 361 },
  "src/components/tabs/useSshTransfer.ts": { lines: 325 },
  "src/components/modals/CommandPalette.tsx": { lines: 345, hooks: 9 },
  "src/components/tabs/FileControlCard.tsx": { lines: 301 },
  // ── 行数合格、但状态数超标 ──
  // 🔴 这两个是“行数拦不住”的活证据：它们都在 300 行以内，
  // 却各自有十几个互相牵扯的状态。SshFileBrowser 就是在这上面出过真 bug 的那个。
  "src/components/backup/BackupCleanupDialog.tsx": { hooks: 13 },
  "src/components/tabs/SshFileBrowser.tsx": { hooks: 12 },
};

function walk(dir, out = []) {
  let items;
  try {
    items = readdirSync(dir);
  } catch {
    return out; // 目录不存在（如 src/hooks 还没建）不算错
  }
  for (const name of items) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 数 useState / useEffect 的调用次数。注释里提到的不算（要求后面跟开括号）。 */
function countHooks(src) {
  const m = src.match(/\buse(State|Effect|LayoutEffect)\s*[<(]/g);
  return m ? m.length : 0;
}

const violations = [];
const shrunk = [];

for (const d of SCAN_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const src = readFileSync(file, "utf8");
    // 与 `wc -l` 一致（数换行符）：文件末尾那个换行后面的空串不算一行。
    // 不统一的话，人用 wc 看到 575、脚本报 576，登基线时必错。
    const lines = src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
    const hooks = countHooks(src);
    const base = BASELINE[rel];

    const lineCap = base?.lines ?? MAX_LINES;
    const hookCap = base?.hooks ?? MAX_HOOKS;

    if (lines > lineCap) {
      violations.push(
        base
          ? `${rel}：${lines} 行，超过登记基线 ${lineCap}（存量文件只允许变小）`
          : `${rel}：${lines} 行，超过上限 ${MAX_LINES}`,
      );
    } else if (base?.lines && lines < base.lines) {
      shrunk.push(`${rel}：${lines} 行（基线 ${base.lines}，可以调低了）`);
    }

    if (hooks > hookCap) {
      violations.push(
        `${rel}：${hooks} 个 useState/useEffect，超过上限 ${hookCap}` +
          `（互相牵扯的状态越多，越容易出“新 effect 撞旧生命周期”这类 bug）`,
      );
    }
  }
}

if (shrunk.length) {
  console.log("ℹ️  以下文件已经变小，请把 BASELINE 里的数字跟着调低（棘轮只往一个方向转）：");
  for (const s of shrunk) console.log(`   - ${s}`);
  console.log("");
}

if (violations.length) {
  console.error("❌ 组件体量门禁未通过（规则 7）：");
  for (const v of violations) console.error(`   - ${v}`);
  console.error("");
  console.error("   拆分思路：复杂状态逻辑 → hooks/useXxx.ts，独立 UI 区块 → 子组件，纯计算 → lib/。");
  console.error("   注意：把代码搬进 hook 只为了降行数不算拆分，本脚本同样扫 `.ts`。");
  process.exit(1);
}

console.log("✅ 组件体量门禁通过");
