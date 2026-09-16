/**
 * SFTP 传输的对外类型契约。
 *
 * 2026-09-16：从 `components/tabs/useSshTransfer.ts` 抽出成独立文件。理由是这些类型
 * 被 `SshTransferBar`（纯 UI）和 `useSshFileForms`（表单编排）分别引用，而它们**并不
 * 需要 hook 实现**——把类型和实现绑在同一个文件里，等于让所有消费方都背上这份依赖。
 * 顺带也让那个 hook 少背 40 行（它已超组件体量门禁的登记基线）。
 */

export type TransferKind = "up" | "down";

export interface TransferState {
  kind: TransferKind;
  name: string;
  /** null = 拿不到百分比（握手/认证阶段），UI 显示不定量条。 */
  percent: number | null;
  /** 剩余秒数，null = 还算不出。 */
  eta: number | null;
  /** 批量上传时的序号（从 1 起）与总数；单个传输时为 undefined。 */
  index?: number;
  total?: number;
}

/**
 * 覆盖确认：由调用方渲染对话框，确认后调 `confirm()` 重跑一次。
 *
 * 支持批量：`names` 是全部同名文件，UI 据此决定显示单个路径还是「N 个文件」清单。
 * 批量时必须再给 `skip`（跳过同名、继续传其余的），单个场景不提供。
 */
export interface OverwritePrompt {
  kind: TransferKind;
  /** 展示用：单个文件是它的完整远程路径，批量时是目标目录。 */
  path: string;
  /** 同名文件清单，单个场景长度为 1。 */
  names: string[];
  confirm: () => void;
  /** 跳过同名、继续传其余的。**仅批量提供**：UI 有这个字段才渲染该按钮。 */
  skip?: () => void;
  /** 用户放弃：让等待中的 Promise 以 false 收尾，避免调用方永远悬着。 */
  cancel: () => void;
}

/** 单次传输的发起参数。 */
export interface StartArgs {
  connectionId: string;
  /** 展示用的文件名。 */
  name: string;
  remote: string;
  local: string;
}
