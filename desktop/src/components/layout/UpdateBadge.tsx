import { useEffect, useRef, type ReactNode } from "react";
import { useUpdate, friendlyError, AUTO_RESTART_DELAY_SECS } from "../../contexts/UpdateContext";
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
  const { status, update, progress, progressIndeterminate, bytesPerSec, downloadedBytes, totalBytes, restarting, autoRestartIn, cancelAutoRestart, error, errorCode, errorToastAllowed, manualCheckForUpdate, downloadAndInstall, restart, openUpdateNotes, isDismissed, manualCheck, acknowledgeUptodate } = useUpdate();
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
      // 与弹窗文案对齐：安装已完成，倒计时结束后自动重启（点徽章可取消）。
      toast(`更新已安装，${AUTO_RESTART_DELAY_SECS} 秒后自动重启（点徽章可取消）`, "success");
    } else if (status === "error") {
      const fe = error ? friendlyError(error, errorCode) : null;
      // 自动检查失败不弹：用户没点任何东西，不该收到红色警报（详见 UpdateContext 的
      // errorToastAllowed 注释）。徽章与关于页仍会变成「重试」，信息不会丢。
      if (errorToastAllowed) {
        toast(fe?.friendly ?? "更新检查失败，请重试", "error");
      }
    }
  }, [status]);

  // ─── 重启失败提示 ────────────────────────
  // UpdateContext.restart 在 relaunch 抛错时**刻意保留 status = "ready"**（否则徽章
  // 会退化成「重试」，用户被迫重走一遍检查 + 下载）。于是这里不能靠 status 变化提示，
  // 改监听 `restarting` 回落：过渡层收起 + 仍是 ready + 有 error 三条同时成立，
  // 只可能是「relaunch 抛了」。用 ref 记上一拍，避免初始化（false → false）误报。
  // 依赖写全是安全的：多出来的那几次运行都在 `!was` 处直接返回，不会重复弹。
  const prevRestartingRef = useRef(restarting);
  useEffect(() => {
    const was = prevRestartingRef.current;
    prevRestartingRef.current = restarting;
    if (!was || restarting) return;
    if (status !== "ready" || !error) return;
    // 刻意不用 friendlyError：那套文案是给「下载/检查」失败写的（网络、DNS、403…），
    // 套到重启失败上会得到「更新失败，请重试」—— 而更新**早已下载安装完成**，
    // 让用户再去「重试」只会白走一轮检查 + 下载。这里说的必须是「重启」这件事。
    toast("重启失败，请手动重启应用", "error");
  }, [restarting, status, error, toast]);

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
    // 下载期的明细由 Header 中段的 UpdateReadout 承担（窗口太窄放不下时，
    // 本槽位的百分比 + 顶部进度线就是全部反馈）。
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
  // 两种子态共用一个 66px 槽位：
  // - 倒计时中 `8s`（时钟图标）：点击 = **取消**自动重启。这里必须让点击语义
  //   变成「撤销」，否则用户看到「8s 后重启」的第一反应点下去反而立即重启。
  // - 已取消/手动 `重启`（对勾图标）：点击 = 立即重启。
  // 文案都是 2-3 字符，槽位宽度不变 ⇒ foot 高度与导航区零位移。
  if (status === "ready") {
    const counting = autoRestartIn !== null;
    return (
      <Slot>
        <button
          className="header-badge header-badge-ready cursor-pointer tabular-nums"
          title={
            counting
              ? `${autoRestartIn} 秒后自动重启 · 点击取消`
              : "更新已安装，点击重启"
          }
          onClick={counting ? cancelAutoRestart : handleClick}
        >
          <Icon name={counting ? "clock" : "check"} size={10} />
          <span>{counting ? `${autoRestartIn}s` : "重启"}</span>
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
    // title 里带上原始错误串：用户反馈时能直接复制。否则界面上只剩一句
    // 「更新失败」，我们无从判断是 Gitee 404、代理 502 还是验签失败。
    const errorTitle = error
      ? `${friendlyError(error, errorCode).friendly}\n\n原因：${error}`
      : "更新检查失败，点击重试";
    return (
      <Slot>
        <button
          className="header-badge header-badge-error cursor-pointer"
          title={errorTitle}
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
