/** A pipe write, a CLI replay and a correlated result are different delivery milestones. */
export type CcInputMode = "steer" | "now" | "queue";
export type CcInputStatus = "preparing" | "written" | "received" | "processing" | "complete" | "failed" | "unconfirmed";
export type CcInput = { messageId: string; text?: string; mode?: string; status: CcInputStatus; detail?: string | null };
export type CcInputs = Record<string, CcInput>;
export const inputPending = (status: string) => ["preparing", "written", "received", "processing"].includes(status);
export const hasPendingInput = (inputs: CcInputs = {}) => Object.values(inputs).some(input => inputPending(input.status));
const rank = (status: string) => ["preparing", "written", "received", "processing", "complete"].indexOf(status);

export function updateInput(inputs: CcInputs = {}, patch: Partial<CcInput> & Pick<CcInput, "messageId">): CcInputs {
  const previous = inputs[patch.messageId];
  const status = patch.status ?? previous?.status ?? "preparing";
  // A fast reply can beat the command's local write receipt. Never regress its status.
  const staleWrite = previous?.status === "unconfirmed" && ["preparing", "written"].includes(status);
  const keep = previous && (previous.status === "complete" || staleWrite || (rank(status) >= 0 && rank(status) < rank(previous.status)));
  const next = { ...previous, ...patch, status: keep ? previous.status : status };
  const entries = Object.entries({ ...inputs, [patch.messageId]: next });
  // Keep all unfinished deliveries and a bounded recent history.
  const recent = new Set(entries.slice(-64).map(([id]) => id));
  return Object.fromEntries(entries.filter(([id, input]) => recent.has(id) || inputPending(input.status)));
}

export function endInputs(inputs: CcInputs = {}): CcInputs {
  return Object.fromEntries(Object.entries(inputs).map(([id, input]) => [id, inputPending(input.status) ? { ...input, status: "unconfirmed", detail: "连接已结束，无法确认是否处理；不会自动重发" } : input]));
}

export const inputStatusLabel: Record<CcInputStatus, string> = {
  preparing: "正在发送补充", written: "等待 CLI 接收", received: "CLI 已接收", processing: "已进入回复",
  complete: "本轮已结束", failed: "补充未发送", unconfirmed: "处理状态未确认",
};
