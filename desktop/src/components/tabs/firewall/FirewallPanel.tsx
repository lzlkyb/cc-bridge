import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../../lib/tauri";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { copyText } from "../../../lib/utils";
import type {
  FirewallDiagnosisResponse,
  FirewallIssue,
  FirewallProfileInfo,
} from "../../../lib/types";

/**
 * 防火墙诊断面板的共享零件。
 *
 * 被两处复用：「连接」页的告警块（出问题才现身）与「设置」页的常驻卡片
 * （任何时候都能主动开放/修复规则）。两边共用同一份诊断数据与同一套动作，
 * 避免两处判断不一致。
 */

// ─── 数据 ────────────────────────────────────────────────────

export const FIREWALL_QUERY_KEY = ["firewall-diagnosis"] as const;

/**
 * 读取后端缓存的诊断结果。不会触发真正的查询（那是 `refresh_firewall` 的事），
 * 所以 30s 轮询很便宜；后台每 5 分钟会自己重跑一次真查询。
 */
export function useFirewallDiagnosis(enabled = true) {
  return useQuery<FirewallDiagnosisResponse>({
    queryKey: FIREWALL_QUERY_KEY,
    queryFn: () => invoke<FirewallDiagnosisResponse>("get_firewall_diagnosis"),
    refetchInterval: 30_000,
    enabled,
  });
}

/**
 * 一键修复 / 重新检查两个动作。
 *
 * 修复走 `open_firewall_port`：后端会在一次 UAC 内完成「删旧规则 + 删阻止/废规则 +
 * 写入 profile=any 新规则」，并在成功后自己刷新缓存，因此这里只需重拉数据。
 */
export function useFirewallFix(onRefresh?: () => void) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const fix = async (refetch?: () => void) => {
    setBusy(true);
    try {
      await invoke("open_firewall_port");
      toast("防火墙规则已写入（已覆盖 域/专用/公用 全部配置文件）", "success");
      refetch?.();
      onRefresh?.();
    } catch (e) {
      // 用户取消 UAC 或提权失败：明确提示，不静默
      toast(`修复失败：${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const recheck = async (refetch?: () => void) => {
    setBusy(true);
    try {
      await invoke("refresh_firewall");
      refetch?.();
      onRefresh?.();
      toast("已重新检查防火墙状态", "success");
    } catch (e) {
      toast(`检查失败：${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return { busy, fix, recheck };
}

// ─── 问题码 → 文案/观感 ─────────────────────────────────────────

const ISSUE_TITLE: Record<string, string> = {
  firewallOff: "防火墙已关闭",
  noRule: "未放行端口",
  profileGap: "规则未覆盖当前网络",
  blockRule: "存在阻止规则",
  staleRule: "残留废规则",
  duplicateRule: "重复规则",
  localPolicyBlocked: "组策略禁止本地规则",
  probeUnavailable: "无法检测防火墙状态",
};

/** true = 这条问题直接导致远程连不上（红）；false = 仅影响健康度/判断准确度（黄/灰）。 */
const BLOCKING_CODES = new Set(["noRule", "profileGap", "blockRule", "localPolicyBlocked"]);

function issueTitle(code: string) {
  return ISSUE_TITLE[code] ?? "防火墙问题";
}

/**
 * 筛出「真的会让远程连不上」的问题。
 * 连接页告警块只为这些现身——残留/重复规则这类健康度问题不应该在连接页吓人，
 * 它们只在设置页卡片里列出。
 */
export function blockingIssues(issues: FirewallIssue[]): FirewallIssue[] {
  return issues.filter((i) => BLOCKING_CODES.has(i.code));
}

/** 告警块标题：取最严重的一条问题作为主因，而不是固定一句「未放行端口」。 */
export function firewallHeadline(issues: FirewallIssue[]): string {
  const first = blockingIssues(issues)[0];
  return first ? `远程无法连入：${issueTitle(first.code)}` : "远程可能无法连入";
}

/** 问题清单。每条都把「为什么不通」说清楚，而不是只给一个红/绿点。 */
export function FirewallIssueList({ issues }: { issues: FirewallIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1.5 fw-issues">
      {issues.map((issue, i) => {
        const blocking = BLOCKING_CODES.has(issue.code);
        return (
          <li key={`${issue.code}-${i}`} className={`flex items-start gap-2 text-xs leading-relaxed ${blocking ? "" : "soft"}`}>
            <Icon
              name={blocking ? "alertTriangle" : "info"}
              size={13}
              className={`mt-0.5 shrink-0 ${blocking ? "text-destructive" : "text-muted-foreground"}`}
            />
            <span className="text-muted-foreground">
              <b className={blocking ? "text-destructive" : "text-foreground"}>{issueTitle(issue.code)}</b>
              {"："}
              {issue.detail}
              {!issue.fixable && <span className="ml-1 text-muted-foreground">（无法自动修复）</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── 配置文件覆盖矩阵 ──────────────────────────────────────────

const PROFILE_LABEL: Record<string, string> = {
  Domain: "域",
  Private: "专用",
  Public: "公用",
};

/**
 * 三个配置文件的覆盖情况。这是整个面板最有信息量的一块：
 * Windows 防火墙规则只在「当前活动配置文件」下生效，所以“规则在但不在对的
 * 配置文件上”是最常见、也最难自己发现的失败原因。
 */
export function FirewallProfileMatrix({ profiles }: { profiles: FirewallProfileInfo[] }) {
  if (profiles.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 fw-mx">
      {profiles.map((p) => {
        const label = PROFILE_LABEL[p.name] ?? p.name;
        const tone = !p.active
          ? "border-border bg-secondary/40 text-muted-foreground"
          : p.covered
            ? "border-success/40 bg-success/10 text-success"
            : "border-destructive/40 bg-destructive/10 text-destructive";
        return (
          <span
            key={p.name}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] fw-p ${!p.active ? "" : p.covered ? "ok" : "bad"} ${tone}`}
            title={
              p.active
                ? p.covered
                  ? "当前网络属于此配置文件，且端口已放行"
                  : "当前网络属于此配置文件，但端口未放行——远程连不上就是因为这个"
                : "当前网络不在此配置文件，此处状态不影响连接"
            }
          >
            {p.active && <Icon name={p.covered ? "check" : "alertTriangle"} size={11} />}
            {label}
            {p.active && <span className="opacity-70">· 当前</span>}
            {!p.enabled && <span className="opacity-70">· 已关</span>}
          </span>
        );
      })}
    </div>
  );
}

// ─── 动作按钮组 ─────────────────────────────────────────────

/**
 * 修复 / 重新检查 / 复制手动命令。
 *
 * 修复按钮始终可点（即使当前判为“已放行”）——它本质是幂等的「重建为正确规则」，
 * 让已安装的用户在任何时候都有一个能主动操作的入口，而不是只能等系统报错。
 */
export function FirewallActions({
  data,
  refetch,
  onRefresh,
  compact,
}: {
  data: FirewallDiagnosisResponse | undefined;
  refetch: () => void;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const { toast } = useToast();
  const { busy, fix, recheck } = useFirewallFix(onRefresh);
  const [showManual, setShowManual] = useState(false);

  const manual = data?.manualCommand ?? "";
  const port = data?.diagnosis?.port;
  const policyBlocked = data?.diagnosis?.issues.some((i) => i.code === "localPolicyBlocked") ?? false;

  const copyManual = () => {
    if (!manual) return;
    void copyText(
      manual,
      () => toast("命令已复制到剪贴板", "success"),
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => void fix(refetch)}
          isLoading={busy}
          loadingText="请确认 UAC…"
        >
          <Icon name="shield" size={14} />
          {port ? `一键修复规则（${port}/TCP）` : "一键修复规则"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void recheck(refetch)} disabled={busy}>
          <Icon name="refresh" size={14} />
          重新检查
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShowManual((v) => !v)} disabled={busy}>
          <Icon name="terminal" size={14} />
          {showManual ? "收起手动命令" : "手动命令"}
        </Button>
        {!compact && (
          <span className="text-xs text-muted-foreground">
            点击后弹出一次系统 UAC 授权框，确认即完成「清理旧规则 + 写入正确规则」。
          </span>
        )}
      </div>

      {policyBlocked && (
        <p className="text-xs leading-relaxed text-destructive">
          注意：当前网络的组策略禁止本地防火墙规则生效，上面的修复也会被系统忽略。请联系 IT
          用域策略下发放行规则，或改用反向连接（出站）方式接入。
        </p>
      )}

      {showManual && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">在管理员终端执行（已带 profile=any，三个配置文件一次覆盖）：</p>
          <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-foreground">
              {manual || "—"}
            </code>
            <Button variant="ghost" size="sm" onClick={copyManual} disabled={!manual}>
              复制
            </Button>
          </div>
          {data?.ruleName && (
            <p className="text-xs text-muted-foreground">
              规则名：<code className="rounded bg-secondary/60 px-1">{data.ruleName}</code>
              ，可在「高级安全 Windows Defender 防火墙 → 入站规则」里自行核对。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
