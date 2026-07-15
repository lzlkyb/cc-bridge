import { useEffect, useRef } from "react";
import { useUpdate, friendlyError } from "../../contexts/UpdateContext";
import { useToast } from "../ui/toast";
import { Icon } from "../ui/icon";

/**
 * Header 上的更新状态徽章。
 *
 * 7 种状态全覆盖：
 * - idle        → null（不显示，版本号由 Header 的 version-badge 展示）
 * - checking    → 版本号 pill + 旋转 spinner
 * - available   → 蓝色按钮 "更新 vX.Y.Z"，点击下载
 * - downloading → pill + spinner + "下载中"
 * - ready       → 绿色按钮 "待重启"，点击重启
 * - uptodate    → pill + "已是最新"（4 秒后自动消失回到 null）
 * - error       → 红色 pill + 版本号，可点击重试
 */
export function UpdateBadge({ currentVersion }: { currentVersion?: string }) {
  const { status, update, progress, progressIndeterminate, error, checkForUpdate, downloadAndInstall, restart } = useUpdate();
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
      toast("已是最新版本", "success");
    } else if (status === "ready") {
      toast("更新已下载完成，点击重启以应用", "success");
    } else if (status === "error") {
      const fe = error ? friendlyError(error) : null;
      toast(fe?.friendly ?? "更新检查失败，请重试", "error");
    }
  }, [status]);

  const handleClick = async () => {
    if (status === "available") {
      await downloadAndInstall();
    } else if (status === "ready") {
      await restart();
    } else if (status === "error") {
      await checkForUpdate();
    }
  };

  const ver = update?.version ?? "";

  // ─── idle：显示版本号，可点击检查 ──────────
  if (status === "idle") {
    if (!currentVersion) return null;
    return (
      <button
        className="header-badge header-badge-idle cursor-pointer"
        title={`v${currentVersion} — 点击检查更新`}
        onClick={() => checkForUpdate()}
      >
        <span>v{currentVersion}</span>
      </button>
    );
  }

  // ─── checking ─────────────────────────────
  if (status === "checking") {
    return (
      <span className="header-badge header-badge-checking" title="正在检查更新…">
        <Icon name="spinner" size={10} className="animate-spin" />
        <span>{currentVersion ? `v${currentVersion}` : ""}</span>
      </span>
    );
  }

  // ─── available ────────────────────────────
  if (status === "available") {
    return (
      <button
        className="header-badge header-badge-update cursor-pointer"
        title={`发现新版本 v${ver}，点击下载更新`}
        onClick={handleClick}
      >
        <Icon name="arrowUp" size={10} />
        <span>更新 v{ver}</span>
      </button>
    );
  }

  // ─── downloading ──────────────────────────
  if (status === "downloading") {
    return (
      <span className="header-badge header-badge-downloading" title="正在下载更新…">
        <DownloadRing progress={progress} indeterminate={progressIndeterminate} />
        <span>{progressIndeterminate ? "下载中" : `下载中 ${progress}%`}</span>
      </span>
    );
  }

  // ─── ready ────────────────────────────────
  if (status === "ready") {
    return (
      <button
        className="header-badge header-badge-ready cursor-pointer"
                title="更新已安装，点击重启"
        onClick={handleClick}
      >
        <Icon name="check" size={10} />
        <span>待重启</span>
      </button>
    );
  }

  // ─── uptodate ─────────────────────────────
  if (status === "uptodate") {
    return (
      <span className="header-badge header-badge-uptodate" title="已是最新版本">
        <Icon name="check" size={10} />
        <span>已是最新</span>
      </span>
    );
  }

  // ─── error ────────────────────────────────
  if (status === "error") {
    return (
      <button
        className="header-badge header-badge-error cursor-pointer"
                title="更新检查失败，点击重试"
        onClick={handleClick}
      >
        <Icon name="alertTriangle" size={10} />
        <span>{currentVersion ? `v${currentVersion}` : "出错"}</span>
      </button>
    );
  }

  return null;
}

/** Header 下载进度环：渐变底上使用白色描边。indeterminate 时整体旋转，不显数字。 */
function DownloadRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const size = 14;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, progress));
  const offset = indeterminate ? 0 : c * (1 - clamped / 100);
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
