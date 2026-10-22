import type { ReactNode } from "react";
import { friendlyError, useUpdate } from "../../contexts/UpdateContext";

/**
 * 折叠态侧栏的更新状态点（2026-10-18，混合交互方案）。
 *
 * 背景：`.app-side[data-collapsed] .update-slot { display:none }` 把展开态的
 * 66px 更新槽位整体藏掉了 —— 折叠用户对「可安装 / 待重启 / 失败」三个需要
 * 行动的状态零反馈（只剩一次性 toast 和下载中的顶栏读数）。
 *
 * 交互（经方案对比选定，2026-10-18）：
 * - **状态点直接可点**：点状态点 = 直接执行对应更新动作（打开弹框 / 取消倒计时 /
 *   重试），一步直达 —— 不必「点齿轮进设置页再找徽章」两跳。
 * - **齿轮本身不被替换**：曾考虑「有更新时把设置按钮整个换成更新按钮」，否决 ——
 *   available/error 态会挂数天，设置入口不能被长期劫持；ready 态替换成重启按钮
 *   有肌肉记忆误触重启的风险（重启会杀掉全部 SSH 会话）。
 * - 结构：**overlay 按钮**（设置按钮的兄弟节点、absolute 覆盖其右上角），不是
 *   嵌套交互元素 —— 嵌套 button 非法、span+onClick 过不了 a11y 门禁。
 *   8px 视觉点 + 22px 热区（点最小可命中面积）。
 *
 * 七态浓缩四形按优先级渲染，无更新态返回 null（未读提示由设置按钮内的
 * changelog-dot 承担，与本组件无关）：
 * - available   → 靛蓝脉冲点，点击打开更新详情（已「稍后」过则直接下载）
 * - downloading → 11px 进度环（不可点，title 显示百分比；不确定态旋转，
 *                 animate-spin 已在 data-app-hidden 暂停列表）
 * - ready       → 绿色实心点，点击取消自动重启倒计时（安全动作）
 * - error       → 红色快脉冲点，点击直接重试
 */
export function UpdateCollapsedDot() {
  const { status, update, progress, progressIndeterminate, error, errorCode, isDismissed, openUpdateNotes, downloadAndInstall, cancelAutoRestart, manualCheckForUpdate } = useUpdate();

  // downloading：无需行动（顶栏读数 + 本环就是全部反馈），渲染为不可点元素
  if (status === "downloading") {
    const pct = Math.min(100, Math.max(0, progress));
    return (
      <span className="upd-dot upd-dot--dl" title={`正在下载更新…${progressIndeterminate ? "大小未知" : `${pct}%`}`}>
        <DotRing progress={pct} indeterminate={progressIndeterminate} />
      </span>
    );
  }
  if (status === "available") {
    return (
      <button
        type="button"
        className="upd-dot upd-dot--available"
        title="发现新版本，点击查看更新详情"
        aria-label="发现新版本，点击查看更新详情"
        onClick={() => (isDismissed(update?.version) ? void downloadAndInstall() : openUpdateNotes())}
      />
    );
  }
  if (status === "ready") {
    return (
      <button
        type="button"
        className="upd-dot upd-dot--ready"
        title="更新已安装，点击取消自动重启"
        aria-label="更新已安装，点击取消自动重启"
        onClick={() => cancelAutoRestart()}
      />
    );
  }
  if (status === "error") {
    // 折叠态只有一个 8px 点，title 是唯一的信息出口 —— 必须带上原因，
    // 否则用户只看到一个一直闪的红点，既不知道出了什么事，也不知道是不是自己网络的问题。
    const label = error
      ? `更新失败：${friendlyError(error, errorCode).friendly}`
      : "更新失败，点击重试";
    return (
      <button
        type="button"
        className="upd-dot upd-dot--error"
        title={error ? `${label}\n\n原因：${error}` : label}
        aria-label={label}
        onClick={() => manualCheckForUpdate()}
      />
    );
  }
  return null;
}

/** 11px 迷你进度环：确定态画进度弧（静止），不确定态整体旋转。 */
function DotRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }): ReactNode {
  const size = 11;
  const stroke = 2.2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = indeterminate ? c * 0.42 : c * (1 - Math.min(100, Math.max(0, progress)) / 100);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={indeterminate ? "animate-spin" : ""}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
