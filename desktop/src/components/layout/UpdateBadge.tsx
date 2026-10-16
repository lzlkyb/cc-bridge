import { useEffect, useRef, type ReactNode } from "react";
import { useUpdate, friendlyError } from "../../contexts/UpdateContext";
import { useToast } from "../ui/toast";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/Spinner";
import { formatBytes, formatBytesPerSec } from "../../lib/utils";

/**
 * 侧栏底部的更新槽位（方案 A，2026-10-16 二次改造）。
 *
 * 它曾经是 foot 里的**一整行徽章**：只要 `updateStatus !== "idle"` 就作为新的
 * flex 子项插进 foot，把 foot 从 53.8px 撑到 79.7px、导航区压扁 25.9px ——
 * 用户看到的就是「一点更新，侧栏就跳一下」。现在它降级成**设置行右端一个定宽
 * 格子**，七种状态在同一个格子里原地变形，foot 高度恒定、导航区零位移。
 *
 * 槽位锁 **min-width 66px** 的依据：最长态是「检查中」（spinner + 三字）实测
 * 62.5px，留 3.5px 容差防字体度量差异顶破；其余六态自然宽 42–54px，被锁宽后
 * 彼此差异不可见 —— 这正是目的。
 *
 * 七态（完整信息不丢，只是从可见文案移进 `title`）：
 * - idle        `v0.1.5`   → 点击检查更新
 * - checking    `检查中`    → 旋转 spinner
 * - available   `更新`      → 点击查看更新详情 / 直接下载
 * - downloading `42%`      → 进度环按百分比推进
 * - ready       `重启`      → 点击重启
 * - uptodate    `最新`      → 4 秒后自动回 idle
 * - error       `重试`      → 点击重试
 */
export function UpdateBadge({ currentVersion }: { currentVersion?: string }) {
  const { status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes, error, manualCheckForUpdate, downloadAndInstall, restart, openUpdateNotes, isDismissed, manualCheck, acknowledgeUptodate } = useUpdate();
  const { toast } = useToast();
  const prevStatusRef = useRef(status);

  // ─── 状态变化时触发 toast 通知 ────────────
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    // 仅当状态真正变化时才触发（跳过初始化 idle → idle）
    if (prev === status) return;

    if (status === "available") {
      toast(`发现新版本 v${update?.version ?? ""}`, "info");
    } else if (status === "uptodate") {
      // 仅手动检查时弹「已是最新」提示框；自动检查（启动/定时）只显示版本号 pill
      if (manualCheck) {
        toast("已是最新版本", "success");
        acknowledgeUptodate();
      }
    } else if (status === "ready") {
      toast("更新已下载完成，点击重启以应用", "success");
    } else if (status === "error") {
      const fe = error ? friendlyError(error) : null;
      toast(fe?.friendly ?? "更新检查失败，请重试", "error");
    }
  }, [status]);

  const handleClick = async () => {
    if (status === "available") {
      // 本版本已「稍后」过 → 直接下载；否则打开更新内容弹框
      if (isDismissed(update?.version)) {
        await downloadAndInstall();
      } else {
        openUpdateNotes();
      }
    } else if (status === "ready") {
      await restart();
    } else if (status === "error") {
      await manualCheckForUpdate();
    }
  };

  const ver = update?.version ?? "";
  const pct = Math.min(100, Math.max(0, progress));

  // ─── idle：版本号，可点击检查 ─────────────
  if (status === "idle") {
    // 版本号还没拿到时也留一个空槽位：格子必须常驻，否则设置按钮会横跳。
    if (!currentVersion) return <Slot />;
    return (
      <Slot>
        <button
          className="header-badge header-badge-idle cursor-pointer"
          title={`v${currentVersion} — 点击检查更新`}
          onClick={() => manualCheckForUpdate()}
        >
          <span>v{currentVersion}</span>
        </button>
      </Slot>
    );
  }

  // ─── checking ─────────────────────────────
  if (status === "checking") {
    return (
      <Slot>
        <span className="header-badge header-badge-checking" title="正在检查更新…">
          <Spinner size={10} />
          <span>检查中</span>
        </span>
      </Slot>
    );
  }

  // ─── available ────────────────────────────
  if (status === "available") {
    return (
      <Slot>
        <button
          className="header-badge header-badge-update cursor-pointer"
          title={`发现新版本 v${ver}，点击查看更新详情`}
          onClick={handleClick}
        >
          <Icon name="arrowUp" size={10} />
          <span>更新</span>
        </button>
      </Slot>
    );
  }

  // ─── downloading ──────────────────────────
  if (status === "downloading") {
    // 槽位只放得下百分比，完整读数（速率 / 已下载 / 总量）进 title；
    // 下载期的窗口级明细由 UpdateProgressBar 的 28px 状态条承担。
    const dl = totalBytes
      ? `已下载 ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
      : `已下载 ${formatBytes(downloadedBytes)}`;
    const speed = bytesPerSec > 0 ? ` · ${formatBytesPerSec(bytesPerSec)}` : "";
    return (
      <Slot>
        <span
          className="header-badge header-badge-downloading"
          title={`正在下载更新… ${progressIndeterminate ? "大小未知" : `${pct}%`}${speed} · ${dl}`}
        >
          <DownloadRing progress={pct} indeterminate={progressIndeterminate} />
          <span>{progressIndeterminate ? "下载中" : `${pct}%`}</span>
        </span>
      </Slot>
    );
  }

  // ─── ready ────────────────────────────────
  if (status === "ready") {
    return (
      <Slot>
        <button
          className="header-badge header-badge-ready cursor-pointer"
          title="更新已安装，点击重启"
          onClick={handleClick}
        >
          <Icon name="check" size={10} />
          <span>重启</span>
        </button>
      </Slot>
    );
  }

  // ─── uptodate ─────────────────────────────
  if (status === "uptodate") {
    return (
      <Slot>
        <span className="header-badge header-badge-uptodate" title="已是最新版本">
          <Icon name="check" size={10} />
          <span>最新</span>
        </span>
      </Slot>
    );
  }

  // ─── error ────────────────────────────────
  if (status === "error") {
    return (
      <Slot>
        <button
          className="header-badge header-badge-error cursor-pointer"
          title={error ? friendlyError(error).friendly : "更新检查失败，点击重试"}
          onClick={handleClick}
        >
          <Icon name="alertTriangle" size={10} />
          <span>重试</span>
        </button>
      </Slot>
    );
  }

  return <Slot />;
}

/** 槽位：设置行右端一个定宽格子，七态在原位变形 —— 「零位移」的实现载体。 */
function Slot({ children }: { children?: ReactNode }) {
  return <span className="update-slot">{children}</span>;
}

/** 槽位内下载进度环：渐变底上使用白色描边。indeterminate 时整体旋转，不显数字。 */
function DownloadRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const size = 12;
  const stroke = 2.4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, progress));
  const offset = indeterminate ? c * 0.42 : c * (1 - clamped / 100);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={indeterminate ? "animate-spin" : ""}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#fff"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
