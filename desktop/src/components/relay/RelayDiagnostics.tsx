import type { RelayClientResult, RelayLogEntry, RelaySnapshot } from "../../lib/types";
import { isGeneration, isPending } from "../../lib/relayUsage";
import { Button } from "../ui/button";

export function latestRelayFailure(snapshot: RelaySnapshot | undefined) {
  if (!snapshot?.running) return null;
  if (snapshot.latestClientResult !== undefined) return snapshot.latestClientResult?.failed ? snapshot.latestClientResult : null;
  const latest = snapshot.recent.find((row) => isGeneration(row) && !isPending(row));
  const status = snapshot.latestClientStatus === undefined ? latest?.status : snapshot.latestClientStatus;
  return status && status >= 400 ? { status, failed: true, requestId: latest?.status === status ? latest.requestId : null } : null;
}

export function relayFailureTitle(result: RelayClientResult) {
  if (result.failureStage === "clientToken") return "客户端令牌无效";
  if (result.failureStage === "clientSource") return "客户端地址未通过校验";
  if (result.failureStage === "clientBlocked") return "客户端暂时被封禁";
  if (result.failureStage === "request") return "中转处理请求失败";
  if (result.status === 401 || result.status === 403) return "上游鉴权失败";
  if (result.status === 429) return "上游限流";
  if (result.status === 404) return "上游地址或模型不可用";
  if (result.status >= 500) return "上游服务异常";
  return "最近请求失败";
}

export function RelayFailureNotice({ result, row, onRequest, openGuide, openProvider, copyConfig, disabled }: {
  result: RelayClientResult;
  row?: RelayLogEntry;
  onRequest: (row: RelayLogEntry) => void;
  openGuide: () => void;
  openProvider: () => void;
  copyConfig?: () => void;
  disabled: boolean;
}) {
  const client = result.failureStage?.startsWith("client");
  const message = result.failureStage === "clientToken" ? (copyConfig ? "重新复制远端配置，使用当前中转令牌。" : "在接入指南选中出错的账号，再复制该账号的远端配置。")
    : result.failureStage === "clientBlocked" ? "等封禁解除后，使用更新过令牌的远端配置重试。"
    : result.failureStage === "clientSource" ? "在接入指南核对当前地址和端口。"
    : result.status === 429 ? "检查当前上游的额度，或切到可用的备用上游。"
    : result.failureStage === "request" ? "查看这次请求的处理详情。" : "在上游设置检查地址、模型和鉴权，或测试备用上游。";
  return <div className="relay-work-notice relay-inline relay-wrap relay-spread" role="status">
    <div><strong>{relayFailureTitle(result)} · HTTP {result.status}</strong><span>{message}</span></div>
    <div className="relay-inline relay-wrap">
      {row && <Button variant="outline" size="sm" onClick={() => onRequest(row)}>查看失败详情</Button>}
      {client ? <Button size="sm" disabled={disabled} onClick={result.failureStage !== "clientSource" && copyConfig ? copyConfig : openGuide}>
        {result.failureStage !== "clientSource" && copyConfig ? "复制远端配置" : "打开接入指南"}</Button>
        : result.failureStage !== "request" && <Button size="sm" disabled={disabled} onClick={openProvider}>打开上游设置</Button>}
    </div>
  </div>;
}
