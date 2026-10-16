import { useEffect, useRef, useState } from "react";
import { useUpdate } from "../../contexts/UpdateContext";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";

/** 判定「等待响应」的静默时长：后端进度窗口约 250ms，1.5s ≈ 连续 6 个窗口没有新事件。 */
const STALL_MS = 1500;

/**
 * 下载期读数（方案 B+，2026-10-16 二次改造）：环 · 百分比 · 轨道 · 网速 ·
 * 已下载/总量 · 剩余时间同屏，回答进度线回答不了的「还要多久」。
 *
 * 🔴 它挂在**顶栏中段那块空白 flex 区**（`.app-topbar` 里的拖拽区），不是窗口级浮层。
 *    位置是实测逼出来的：顶栏高 52px、控件垂直居中 ⇒ 图标按钮（36px）占 y=8–44、
 *    窗口控件与 sm 按钮（32px）占 y=10–42，**所有字形/文字都落在 y=18–34**。
 *    任何 ≥18px 的贴顶通栏浮层都会切掉它们 —— 实测 28px 状态条压掉字高 78%，
 *    连窗口的关闭/最小化按钮一起切掉（CDP 探针实测，见
 *    `design/2026-10-16-状态条遮顶栏-取证.html`）。
 *    放进中段空白区则**零遮挡、零布局影响**：该区本来就空着，高度由顶栏固定 52px
 *    兜住 ⇒ 不触发终端 fit，这条红线仍然成立。
 *
 * 🔴 数字不抖三条沿用：① 全程 `tabular-nums`；② 速率段定宽 68px（实测最短「—」与
 *    最长「↓ 999.9 MB/s」同宽）；③ `bytesPerSec === 0` 显示「—」而非隐藏 ——
 *    隐藏会让右侧读数先左移再弹回。轨道是唯一可压缩段，读数铺满中段 ⇒ 轨道长度
 *    随窗口自适应（与旧通栏条同构，故数字位移规律不变）。
 *
 * 不占位的代价换成了别的东西：**窄窗口无位可放**（`.upd-readout` 的两条断点见 index.css），
 * 那时靠侧栏槽位的百分比 + 顶部进度线兜底；全屏终端态下顶栏整体被盖，同样只剩进度线。
 */
export function UpdateReadout() {
  const { status, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes } = useUpdate();
  const active = status === "downloading";

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

  const pct = Math.min(100, Math.max(0, progress));
  const known = !!totalBytes && totalBytes > 0;
  // 剩余时间：只有「总量已知 + 速率有效」才算得出来（速率段已单独表达等待态，这里不重复）。
  const remainSec = known && bytesPerSec > 0 ? (totalBytes! - downloadedBytes) / bytesPerSec : null;
  const eta = remainSec === null ? null : remainSec < 3 ? "即将完成" : `剩余 ${Math.max(1, Math.round(remainSec))} 秒`;
  const dl = known
    ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes!)}`
    : `${formatBytes(downloadedBytes)} 已下载`;

  // 常驻挂载 + is-on 淡入淡出（而非按需卸载）：中段本来就是空白区，留个空元素零成本，
  // 换来一次 320ms 的淡出而不是「啪」地消失 —— 与进度线同一套观感。
  return (
    <div
      className={`upd-readout${active ? " is-on" : ""}`}
      role="progressbar"
      aria-label="正在下载更新"
      aria-hidden={!active}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={active && !progressIndeterminate ? pct : undefined}
    >
      <ReadoutRing progress={pct} indeterminate={progressIndeterminate} />
      <span className="ur-status">{progressIndeterminate ? "下载中" : `下载中 ${pct}%`}</span>
      <span className="ur-track">
        {progressIndeterminate ? <i className="ur-sweep" /> : <i style={{ width: `${pct}%` }} />}
      </span>
      <span className="ur-spd" data-stalled={stalled || undefined}>
        {stalled ? "等待响应…" : bytesPerSec > 0 ? `↓ ${formatBytesPerSec(bytesPerSec)}` : "—"}
      </span>
      <span className="ur-rest">
        {dl}
        {eta && !stalled ? ` · ${eta}` : ""}
      </span>
    </div>
  );
}

/** 12px 进度环：与侧栏槽位同款语义，但底色是顶栏而非渐变 pill，故用 currentColor 描边。 */
function ReadoutRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const size = 12;
  const stroke = 2.4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = indeterminate ? c * 0.42 : c * (1 - progress / 100);
  return (
    <svg
      className={`ur-ring${indeterminate ? " animate-spin" : ""}`}
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
