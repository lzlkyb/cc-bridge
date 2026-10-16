import { useEffect, useRef, useState } from "react";
import { useUpdate } from "../../contexts/UpdateContext";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";

/** 判定「等待响应」的静默时长：后端进度窗口约 250ms，1.5s ≈ 连续 6 个窗口没有新事件。 */
const STALL_MS = 1500;
/** 淡出时长，与 index.css 的 --dur-slow（320ms）对齐，结束时留一拍再卸载。 */
const FADE_MS = 320;

/**
 * 下载期的窗口级进度反馈（方案 B + B+，2026-10-16）。
 *
 * 一个组件两种厚度：
 * - `variant="line"` —— 窗口顶部 2px 通栏进度线，回答「走了多远」（最克制）；
 * - `variant="bar"`  —— 顶部 28px 浮层状态条，环 · 百分比 · 轨道 · 网速 ·
 *   已下载/总量 · 剩余时间同屏，回答「还要多久」。
 *
 * 🔴 两者都必须 `position: fixed` + `pointer-events: none`，**绝不参与布局**：
 *    一旦改成占位元素（哪怕只是给 `app-main` 加个 `border-top` 再动画），
 *    内容区高度就会变 1–2px ⇒ 终端面板触发一次 fit ⇒ 远端 TUI 重排。
 *    这是本项目踩过的坑，所以状态条宁可遮挡也不让位。
 *
 * 🔴 数字不抖三条：① 全程 `tabular-nums`；② 速率段 `min-width: 68px`
 *    （实测最短「—」与最长「↓ 999.9 MB/s」同宽，都是 68px）；③ `bytesPerSec === 0`
 *    时显示「—」而不是隐藏 —— 隐藏会让条先矮一截再长回来。
 */
export function UpdateProgressBar({ variant }: { variant: "line" | "bar" }) {
  const { status, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes } = useUpdate();
  const active = status === "downloading";

  // 淡入 / 淡出：只在下载期存在，但结束时不要「啪」地消失。
  const [visible, setVisible] = useState(active);
  useEffect(() => {
    if (active) {
      setVisible(true);
      return;
    }
    const t = setTimeout(() => setVisible(false), FADE_MS);
    return () => clearTimeout(t);
  }, [active]);

  // 「等待响应」：速率冻结在一个数字上不动，用户会以为卡死。有事件就刷新心跳，
  // 静默超过 STALL_MS 才转灰 —— 真卡死时进度事件不再来，这个定时器是唯一的信号源。
  const [stalled, setStalled] = useState(false);
  const beatRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    beatRef.current = Date.now();
    setStalled(false);
  }, [active, downloadedBytes, bytesPerSec]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setStalled(Date.now() - beatRef.current > STALL_MS);
    }, 400);
    return () => clearInterval(t);
  }, [active]);

  if (!visible) return null;

  const pct = Math.min(100, Math.max(0, progress));
  const on = active ? " is-on" : "";

  if (variant === "line") {
    return (
      <div className={`update-line${on}`} aria-hidden="true">
        {progressIndeterminate ? (
          <i className="update-line-sweep" />
        ) : (
          <i style={{ transform: `scaleX(${pct / 100})` }} />
        )}
      </div>
    );
  }

  const known = !!totalBytes && totalBytes > 0;
  // 剩余时间：只有「总量已知 + 速率有效」才算得出来（速率段已单独表达等待态，这里不重复）。
  const remainSec = known && bytesPerSec > 0 ? (totalBytes! - downloadedBytes) / bytesPerSec : null;
  const eta = remainSec === null ? null : remainSec < 3 ? "即将完成" : `剩余 ${Math.max(1, Math.round(remainSec))} 秒`;
  const dl = known
    ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes!)}`
    : `${formatBytes(downloadedBytes)} 已下载`;

  return (
    <div
      className={`update-bar${on}`}
      role="progressbar"
      aria-label="正在下载更新"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressIndeterminate ? undefined : pct}
    >
      <BarRing progress={pct} indeterminate={progressIndeterminate} />
      <span className="ub-status">{progressIndeterminate ? "下载中" : `下载中 ${pct}%`}</span>
      <span className="ub-track">
        {progressIndeterminate ? <i className="ub-sweep" /> : <i style={{ width: `${pct}%` }} />}
      </span>
      <span className="ub-spd" data-stalled={stalled || undefined}>
        {stalled ? "等待响应…" : bytesPerSec > 0 ? `↓ ${formatBytesPerSec(bytesPerSec)}` : "—"}
      </span>
      <span className="ub-rest">
        {dl}
        {eta && !stalled ? ` · ${eta}` : ""}
      </span>
    </div>
  );
}

/** 12px 进度环：与侧栏槽位同款语义，但底色是浮层而非渐变 pill，故用 currentColor 描边。 */
function BarRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const size = 12;
  const stroke = 2.4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = indeterminate ? c * 0.42 : c * (1 - progress / 100);
  return (
    <svg
      className={`ub-ring${indeterminate ? " animate-spin" : ""}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.22} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
