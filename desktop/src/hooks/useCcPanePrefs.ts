import { useCallback, useEffect, useState } from "react";
import type { CcRestore } from "../lib/ccEventTypes";
import type { CcForkSeed } from "../lib/ccFork";
import type { CcPermissionMode } from "../lib/ccGuiTypes";
import {
  readCwd,
  readMode,
  readModel,
  restorePlan,
  saveCwd,
  saveMode,
  saveModel,
} from "../lib/ccGuiPrefs";

/**
 * 一条 pane 的「运行配置」：目标（本机/某台 SSH）、工作目录、模型、权限档位。
 *
 * 2026-10-25 从 `CcPane` 拆出。这不是为了行数：这四样是**一条会话往哪跑**的
 * 全部答案，它们的读写规则（按目标记目录、跟着会话恢复、改了就落盘）与界面
 * 渲染毫无关系，且批 3-3 的「分叉会话」要复制的正是这一份。
 *
 * 三条容易踩的规则全在这里闭环，调用方不必再想：
 * 1. 目录**按目标**各记一份 —— 本机的 `D:/proj` 喂给远端只会得到一句看不懂的报错；
 * 2. 恢复会话时 `saveCwd` 必须**先于** `setTargetId`：目标一变就会立刻按新 key
 *    重读 localStorage，晚一步就被旧值覆盖；
 * 3. `claudePath` 故意不采信库里的值（可能早已失效），重探更可靠。
 */
export function useCcPanePrefs() {
  const [targetId, setTargetId] = useState("");
  const [cwd, setCwd] = useState("");
  const [mode, setModeRaw] = useState<CcPermissionMode>(readMode);
  // 下一轮的模型。空串 = 不传 `--model`，吃 CLI 自己的默认。全局偏好，不按连接分。
  const [model, setModelRaw] = useState(readModel);

  // 每台机器记各自的工作目录。
  useEffect(() => {
    setCwd(readCwd(targetId));
  }, [targetId]);

  const setMode = useCallback((m: CcPermissionMode) => {
    setModeRaw(m);
    saveMode(m);
  }, []);

  const setModel = useCallback((m: string) => {
    setModelRaw(m);
    saveModel(m);
  }, []);

  /** 目录改动要落盘（用户手输的那个入口）。 */
  const setCwdPersist = useCallback(
    (v: string) => {
      setCwd(v);
      saveCwd(targetId, v);
    },
    [targetId],
  );

  /** 把恢复出来的会话**连同它的目标**一起还原（判据见 `restorePlan`）。 */
  const applyRestore = useCallback((restored: CcRestore) => {
    const p = restorePlan(restored);
    saveCwd(p.connectionId, p.cwd);
    setTargetId(p.connectionId);
    setCwd(p.cwd);
    if (p.mode) {
      setModeRaw(p.mode);
      saveMode(p.mode);
    }
    if (p.model) {
      setModelRaw(p.model);
      saveModel(p.model);
    }
  }, []);

  /**
   * 分叉出来的会话要**继承源会话的运行配置**（3-3）。
   *
   * 四条一起还原，理由与 `applyRestore` 同源：分叉的语义是「同一件事换个说法重跑」，
   * 目标 / 目录 / 模型 / 权限档只要差一条，跑出来的东西就不是同一个语境 ——
   * 最典型的是远端会话分叉成本机会话：上下文里的路径一个都不存在。
   *
   * 🔴 `saveCwd` 必须在 `setTargetId` 之前：目标一变就会按新 key 重读 localStorage。
   */
  const applySeed = useCallback((seed: CcForkSeed) => {
    saveCwd(seed.connectionId, seed.cwd);
    setTargetId(seed.connectionId);
    setCwd(seed.cwd);
    setModeRaw(seed.permissionMode);
    saveMode(seed.permissionMode);
    setModelRaw(seed.model);
    saveModel(seed.model);
  }, []);

  /**
   * 打开一条 CLI 历史后把目标切成本机 + 用它的目录。
   *
   * 🔴 本机历史一律切回 `""`：`cc_start` 会拿 `connection_id` + `cwd` 和内存里的
   * facts 比，不一致就判「换了目标」并**清掉 resume id** —— 那时打开的历史会
   * 静悄悄变成一条新会话，用户看到的是「我问了它一句，它完全不记得上面」。
   */
  const applyOpenedCwd = useCallback((dir: string) => {
    saveCwd("", dir);
    setTargetId("");
    setCwd(dir);
  }, []);

  return {
    targetId,
    setTargetId,
    cwd,
    setCwdPersist,
    mode,
    setMode,
    model,
    setModel,
    applyRestore,
    applySeed,
    applyOpenedCwd,
  };
}
