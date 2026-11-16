import type { StaticStatus } from "../../lib/types";
import { CONNECT_GUIDE_ANCHOR } from "../../lib/connectionAccess";
import { ActionCard } from "../ui/notice";
import { Button } from "../ui/button";

export function CurrentConnectionAlert({ status, onNavigate }: { status?: StaticStatus; onNavigate: (tab: string, anchor?: string) => void }) {
  const authIssue = !!status?.multiDeviceMode && status.authFailureSources > 0;
  // Connection state is already in the title bar; only this separate access issue needs a notice.
  if (!authIssue) return null;
  return <div className="shrink-0 px-5 pt-2"><ActionCard tone="warning"
    title="本机收到使用失效令牌的访问"
    summary="请在原接入位置同步最新令牌；此提示统计本机全部接入。">
    <Button variant="outline" size="sm" className="h-6 px-2.5 text-xs" onClick={() => onNavigate("connect", CONNECT_GUIDE_ANCHOR)}>查看接入</Button>
  </ActionCard></div>;
}
