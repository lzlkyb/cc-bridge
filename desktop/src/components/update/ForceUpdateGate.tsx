import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { UpdateBrand } from "./UpdateBrand";
import { UpdateNotesDialog } from "./UpdateNotesDialog";
import { UpdateProcess } from "./UpdateProcess";
import { friendlyError, useUpdate } from "../../contexts/UpdateContext";
import { useUpdateRestartSafety } from "../../hooks/useUpdateRestartSafety";

/**
 * 强制更新遮罩：当前版本低于「最低可用版本」时覆盖整个界面。
 *
 * ## 为什么和普通更新弹框分开
 *
 * 普通弹框是「提醒」：可以稍后、可以忽略、可以点遮罩关掉。这些路径在强制场景下
 * 全都必须消失，否则约束形同虚设。所以这里：
 * - `dismissible={false}`：Esc / 点遮罩 / 右上角关闭全部失效；
 * - 动作区只有「立即更新」和「退出软件」，没有「忽略此版本」「稍后提醒」。
 *
 * ## 两种形态
 *
 * - 还没开始下载（`update` 为空）：自建首屏，展示「当前版本 → 最低版本」与原因；
 * - 点过「立即更新」后（`start_update` 会推 `update:available` 补全详情）：直接复用
 *   普通更新弹框的内容，只把动作区换成强制版 —— 避免为同一件事维护两套视觉。
 *
 * ## 逃生口
 *
 * 遮罩保留「退出软件」。策略写错时用户至少能退出，而不是被永久锁在一个打不开的
 * 界面里（发布侧的 `min <= latest` 校验是第一道，这是第二道）。
 */
export function ForceUpdateGate() {
  const {
    forceUpdate, update, status, progress, progressIndeterminate, bytesPerSec,
    downloadedBytes, totalBytes, error, errorCode, restarting, startForcedUpdate, quitApp, restart,
  } = useUpdate();
  const { safety, refresh } = useUpdateRestartSafety(forceUpdate.active && status === "ready");

  if (!forceUpdate.active) return null;

  const verdict = forceUpdate.verdict;
  const current = update?.currentVersion ?? verdict?.currentVersion ?? "";
  const target = update?.version ?? verdict?.latestVersion ?? verdict?.minSupportedVersion ?? "";
  const min = verdict?.minSupportedVersion ?? target;
  const reason = verdict?.message || `请升级到 v${min} 或更高版本后继续使用。`;

  // 强制遮罩不吃「普通检查中」这个状态：后端策略已经给出结论，启动时并行的
  // check_update 还在转圈只是噪音 —— 若把它透进来，用户会看到「正在准备…」且按钮
  // 不可点，误以为卡住。只认下载/已安装/失败三态。
  const process = {
    status: (status === "downloading" || status === "ready" || status === "error"
      ? status
      : "available") as "available" | "downloading" | "ready" | "error",
    progress,
    indeterminate: progressIndeterminate,
    bytesPerSec,
    downloadedBytes,
    totalBytes,
    error: status === "ready" ? error : error ? friendlyError(error, errorCode).friendly : null,
    safety,
    restarting,
  };

  // 已经拿到版本详情（下载中 / 已安装）：复用普通弹框，只切到强制动作区。
  if (update) {
    return (
      <UpdateNotesDialog
        open
        requirement={{ minimumVersion: min, reason }}
        update={update}
        process={process}
        onClose={() => undefined}
        onDownload={startForcedUpdate}
        onDismiss={() => undefined}
        onRestart={restart}
        onRetry={startForcedUpdate}
        onRefreshSafety={refresh}
        onQuit={quitApp}
      />
    );
  }

  const busy = status === "downloading";
  const latest = verdict?.latestVersion ?? "";
  const fmt = (v: string) => `v${v.replace(/^v/, "")}`;
  return (
    <Modal
      open
      onClose={() => undefined}
      dismissible={false}
      zIndex={2500}
      ariaLabel="必须更新后才能继续使用"
      className="modal-surface update-dialog"
      // 初始焦点给主按钮：否则焦点落在 tabIndex=0 的滚动区，
      // `:focus-visible` 会沿它画一整圈 2px 描边（空内容时像一条多余边框）。
      initialFocus="[data-force-primary]"
    >
      <UpdateBrand currentVersion={current} version={target || "新版本"} ready={false} />
      <div className="update-dialog-main">
        <header className="update-dialog-header">
          <h2>需要更新后才能继续使用</h2>
          <p>
            {current ? `当前 v${current.replace(/^v/, "")}` : "当前版本"}
            {min ? ` 已低于最低支持版本 v${min.replace(/^v/, "")}` : "已不再受支持"}
          </p>
        </header>
        <div className="update-dialog-scroll" tabIndex={0} role="region" aria-label="更新说明">
          <section className="update-release-summary" aria-label="更新原因">
            <p>{reason}</p>
          </section>
          {/* 这一步还没查清单，没有更新正文可展示；用版本事实把空白填成信息，
              否则右侧会空出一大块，看着像加载失败。 */}
          <dl className="update-force-facts" aria-label="版本信息">
            {min ? (
              <div>
                <dt>最低支持版本</dt>
                <dd>{fmt(min)}</dd>
              </div>
            ) : null}
            {latest ? (
              <div>
                <dt>最新版本</dt>
                <dd>{fmt(latest)}</dd>
              </div>
            ) : null}
            <div>
              <dt>更新方式</dt>
              <dd>下载并安装，按提示完成重启</dd>
            </div>
          </dl>
          <UpdateProcess process={process} force />
        </div>
        <footer className="update-dialog-footer">
          <p className="update-restart-note">
            <span>更新会关闭终端连接，请先保存当前工作。</span>
          </p>
          <div className="update-dialog-actions">
            <Button variant="outline" onClick={quitApp}>退出软件</Button>
            <Button data-force-primary onClick={startForcedUpdate} disabled={busy}>
              {status === "error" ? "重试更新" : busy ? "正在准备…" : "立即更新"}
            </Button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
