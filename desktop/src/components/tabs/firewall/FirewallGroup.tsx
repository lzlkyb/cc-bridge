import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { SettingsRow } from "../../ui/SettingsRow";
import { Icon } from "../../ui/icon";
import {
  useFirewallDiagnosis,
  FirewallActions,
  FirewallIssueList,
  FirewallProfileMatrix,
} from "./FirewallPanel";

/**
 * 设置页「防火墙」常驻卡片。
 *
 * 与「连接」页告警块的分工：告警块只在出问题时现身（引导），本卡片始终存在（控制台）。
 * 这很重要：已经装了软件的老用户很可能当初直接关了防火墙或手动加过残缺规则，
 * 必须给他们一个「任何时候都能主动重建为正确规则」的入口，而不是只能等报错。
 */
export function FirewallGroup({ onRefresh }: { onRefresh?: () => void }) {
  const { data, refetch } = useFirewallDiagnosis();
  const diag = data?.diagnosis ?? null;

  // 右上角状态徽章。注意 portOpen 已是「真结论」（计入配置文件覆盖与阻止规则），
  // 不再是旧版那个「有没有一条像样的规则」。
  const badge = !data
    ? { tone: "muted", text: "检测中…" }
    : !data.available
      ? { tone: "muted", text: "检测不可用" }
      : !diag
        ? { tone: "muted", text: "检测中…" }
        : diag.portOpen === true
          ? { tone: "ok", text: `已放行 ${diag.port}/TCP` }
          : diag.portOpen === false
            ? { tone: "bad", text: `未放行 ${diag.port}/TCP` }
            : { tone: "muted", text: "状态未知" };

  const badgeClass =
    badge.tone === "ok"
      ? "border-success/40 bg-success/10 text-success"
      : badge.tone === "bad"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-border bg-secondary/60 text-muted-foreground";

  const checkedHint =
    data?.checkedSecondsAgo == null
      ? "尚未检查"
      : data.checkedSecondsAgo < 60
        ? `${data.checkedSecondsAgo} 秒前检查`
        : `${Math.floor(data.checkedSecondsAgo / 60)} 分钟前检查`;

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="shield" />}>
          防火墙
          <span
            className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-normal fw-badge ${badge.tone} ${badgeClass}`}
          >
            {badge.tone !== "muted" && (
              <Icon name={badge.tone === "ok" ? "check" : "alertTriangle"} size={11} />
            )}
            {badge.text}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {diag && diag.profiles.length > 0 && (
          <SettingsRow
            layout="stack"
            label={
              <span className="flex items-center justify-between gap-3">
                <span>当前网络覆盖情况</span>
                <span className="text-xs font-normal text-muted-foreground">{checkedHint}</span>
              </span>
            }
            sub="Windows 规则只在「当前活动配置文件」下生效——规则在、却没覆盖当前网络是最常见的连不上原因"
            control={
              <div className="space-y-2">
                <FirewallProfileMatrix profiles={diag.profiles} />
                <FirewallIssueList issues={diag.issues} />
              </div>
            }
          />
        )}

        <SettingsRow
          last
          layout="stack"
          label="规则管理"
          sub="一键修复是幂等的「重建为正确规则」（profile=any，三个配置文件一次覆盖），随时可点，不会重复堆积"
          control={<FirewallActions data={data} refetch={refetch} onRefresh={onRefresh} />}
        />

        {data && !data.available && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            本机 PowerShell 与 <code className="rounded bg-secondary/60 px-1">netsh</code>
            均不可用，无法读取防火墙状态。这<strong>不影响服务运行</strong>，请用上方「手动命令」自行添加规则。
          </p>
        )}
        {diag?.source === "netsh" && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            诊断能力受限：本机 PowerShell 的 NetSecurity 模块不可用，已回退到
            <code className="mx-1 rounded bg-secondary/60 px-1">netsh</code>
            文本解析，只能判断「有没有一条命中端口的规则」，拿不到配置文件覆盖与阻止规则信息。不影响一键修复。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
