import { useEffect, useRef, useState } from "react";
import { buildForkPrompt, type CcForkSeed } from "../lib/ccFork";

/**
 * 分叉出来的 pane 的启动生命周期（批 3-3）。
 *
 * 两步，而且**必须是两步**：
 * 1. 先把源会话的运行配置搬进来（`applySeed`）；
 * 2. 等配置真的落到渲染层之后再发那句话（`start`）。
 *
 * 合成一步的后果很隐蔽：`applySeed` 触发的状态更新要等下一次渲染才写进
 * `useCcSession` 的 `targetRef`，同一个 effect 里紧接着 `start()` 读到的还是旧目标
 * —— 表现是「从远端会话分叉出来的新会话在本机跑」。本机恰好也装了 claude，
 * 于是它真的跑起来了，只是文件和上下文全不对，界面上没有任何异常。
 *
 * 远端还要等探测拿到绝对路径：非登录 shell 没有 `~/.local/bin` 那份 PATH，
 * 不带路径等于「远端没装 claude」。探测失败时**不发**（那一步自己会报错），不猜。
 *
 * 只发一次：`sent` 是 ref，重渲染不会重发（否则每来一条事件就再发一遍那句话）。
 */
export function useCcForkSeedRun({
  seed,
  ready,
  isRemote,
  probeFound,
  applySeed,
  start,
}: {
  /** `null` = 这条 pane 不是分叉出来的，本 hook 什么都不做。 */
  seed: CcForkSeed | null;
  /** 事件流就绪（快照已重放、内部 id 已铸发）。 */
  ready: boolean;
  /** 目标是远端（要等探测）。 */
  isRemote: boolean;
  /** 探测到 claude 了。 */
  probeFound: boolean;
  applySeed: (seed: CcForkSeed) => void;
  start: (text: string) => void;
}) {
  const [seeded, setSeeded] = useState(seed === null);
  useEffect(() => {
    if (!seed) return;
    applySeed(seed);
    setSeeded(true);
  }, [seed, applySeed]);

  const sent = useRef(false);
  useEffect(() => {
    if (!seed || !seeded || !ready || sent.current) return;
    if (isRemote && !probeFound) return;
    sent.current = true;
    start(buildForkPrompt(seed));
  }, [seed, seeded, ready, isRemote, probeFound, start]);
}
