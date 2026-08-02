import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";
import { copyText } from "../../../lib/utils";
import { CommandBlock } from "./widgets";
import {
  useFirewallDiagnosis,
  blockingIssues,
  firewallHeadline,
  FirewallActions,
  FirewallIssueList,
  FirewallProfileMatrix,
} from "../firewall/FirewallPanel";

/**
 * 防火墙告警块（诊断驱动）。
 *
 * 与旧版的关键区别：是否现身、以及说什么，都由后端结构化诊断决定，而不是
 * 看一个 `firewallPortOpen` 布尔值。旧逻辑在三种常见情形下会假绿（规则只覆盖
 * Public / 规则指向旧路径 / 存在 Block 规则），用户看到“已放行”却仍连不上，
 * 最后只能去关整个防火墙。
 *
 * 只为「真的会让远程连不上」的问题现身；残留/重复规则这类健康度问题交由
 * 设置页的「防火墙」卡片展示，不在连接页制造噪声。
 */
export function FirewallAlertBlock({
  port,
  onRefresh,
}: {
  port: number;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const { data, refetch } = useFirewallDiagnosis();
  const diag = data?.diagnosis ?? null;

  // 首次检查完成前不乱报；无阻塞类问题时不现身。
  const issues = diag ? blockingIssues(diag.issues) : [];
  if (!diag || issues.length === 0) return null;

  const healthCmd = `curl http://<本机IP>:${port}/health`;
  const copyCmd = (cmd: string, label: string) => {
    if (!cmd) return;
    void copyText(
      cmd,
      () => toast(`${label}已复制到剪贴板`, "success"),
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  return (
    <div className="animate-fade-in space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
          <Icon name="shield" size={15} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-destructive">{firewallHeadline(diag.issues)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            本机 Windows 防火墙已开启，但 <code className="rounded bg-background px-1">{port}/TCP</code>{" "}
            的入站放行在当前网络下没有生效。远程服务器上 Claude Code
            发来的请求会被拦截（即使本地服务正常运行）。
          </p>
        </div>
      </div>

      <div className="space-y-2 pl-[38px]">
        <FirewallProfileMatrix profiles={diag.profiles} />
        <FirewallIssueList issues={issues} />
      </div>

      <div className="pl-[38px]">
        <FirewallActions data={data} refetch={refetch} onRefresh={onRefresh} />
      </div>

      <div className="space-y-1.5 pl-[38px]">
        <p className="text-xs text-muted-foreground">
          在远程服务器上验证连通（返回 {"{"}"status":"ok"{"}"} 即可用该 IP）：
        </p>
        <CommandBlock command={healthCmd} copied={false} onCopy={() => copyCmd(healthCmd, "命令")} />
      </div>
    </div>
  );
}
