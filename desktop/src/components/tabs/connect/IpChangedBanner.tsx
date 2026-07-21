import { useEffect, useRef, useState } from "react";
import { Icon } from "../../ui/icon";
import { McpScope, copyText } from "../../../lib/utils";
import { CommandBlock } from "./widgets";
import { useToast } from "../../ui/toast";

/**
 * 地址变化醒目 banner：仅 status.ipChanged 为真（或 ipResolvedByUser 兜底）时渲染。
 * 确认选中新 IP 并复制命令后，onResolved 会重新落盘 last_selected_ip，下一次轮询
 * ip_changed 回为 false，banner 自行消失。
 *
 * 方案 B（自动收起）：弹出先完整展开（给足注意力），约 60s 后自动折叠成一条细条
 * （不消失、保留入口）；折叠细条上直接带「复制」按钮，可一键复制 sed 而无需展开；
 * 用户手动点开细条后保持展开、不再自动收起。复制成功 / 点 × 仍按原逻辑收口 / 忽略。
 */
export function IpChangedBanner({
  lanIps,
  selectedIp,
  previousIp,
  port,
  scope,
  projectPath,
  onResolved,
  onSedResolved,
  onDismiss,
}: {
  lanIps: string[];
  selectedIp: string;
  previousIp: string | null;
  port: number;
  scope: McpScope;
  projectPath: string;
  onResolved: (ip: string) => void;
  onSedResolved: () => void;
  onDismiss?: () => void;
}) {
  const [copiedCmd, setCopiedCmd] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [countdown, setCountdown] = useState(60);
  // 仅首次自动折叠一次；用户手动展开后保持展开，不再定时收起
  const autoCollapsed = useRef(false);
  const { toast } = useToast();

  // 方案 B：弹出先展开，约 60s 后自动折叠为细条（仅自动折叠一次）。
  // 同步驱动可视倒计时（250ms 精度、按秒向上取整显示），到 0 收起。
  useEffect(() => {
    if (!expanded || autoCollapsed.current) return;
    const total = 60000;
    const start = Date.now();
    setCountdown(60);
    const id = setInterval(() => {
      const remain = total - (Date.now() - start);
      if (remain <= 0) {
        clearInterval(id);
        autoCollapsed.current = true;
        setExpanded(false);
        return;
      }
      setCountdown(Math.ceil(remain / 1000));
    }, 250);
    return () => clearInterval(id);
  }, [expanded]);

  // 网卡全部消失时，下方选择控件与确认按钮会永久 disabled 形成死局。
  // 此时只给说明、不渲染选择控件；网络恢复、网卡重新出现后会自动回到正常分支。
  if (lanIps.length === 0) {
    return (
      <div className="animate-fade-in relative space-y-3 rounded-lg border border-destructive/35 bg-destructive/[0.08] p-4">
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="关闭提示"
            title="本次会话忽略此提示"
            className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-foreground"
          >
            <Icon name="close" size={14} />
          </button>
        )}
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
            <Icon name="alertTriangle" size={15} />
          </div>
          <div>
            <p className="text-sm font-semibold text-destructive">检测到网络地址变化</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              之前使用的 <code className="rounded bg-background px-1">{previousIp ?? "原地址"}</code> 已不在本机网卡列表中,且当前没有任何可用的网络地址。请检查网络连接,恢复后本应用将自动重新检测并更新连接命令。
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 原地替换 url 里的 host：sed 匹配任意旧 IP（[0-9.]*），幂等可重跑，
  // 不动 Bearer、不 remove+add，因此服务器条目与授权状态保留、不会重新授权。
  // 作用域直接读下方选择卡当前选中的 scope（方案 A：实时联动），始终输出单条精确命令。
  const buildSed = (scp: "user" | "project") => {
    const cfgFile = scp === "user" ? "~/.claude.json" : ".mcp.json";
    const cdPrefix =
      scp === "project" && projectPath.trim() ? `cd "${projectPath.trim()}" && ` : "";
    return `${cdPrefix}sed -i 's#http://[0-9.]*:${port}/mcp#http://${selectedIp}:${port}/mcp#g' ${cfgFile}`;
  };

  const entries: { label: string; cmd: string }[] = [
    {
      label: scope === "user" ? "全局（~/.claude.json）" : "项目（.mcp.json）",
      cmd: buildSed(scope),
    },
  ];

  // 仅当用户已在下方 AddressPicker 选中一个当前在网卡列表中的「新」地址时，
  // 才允许生成/复制 sed（把远程配置里的旧 IP 替换为选中的新 IP）。
  // selectedIp 为空或仍是已消失的旧地址时，sed 无意义，禁用复制。
  const newIpValid = !!selectedIp && lanIps.includes(selectedIp);

  // H6 修复：之前未 await/catch，剪贴板写入失败时仍会调 onResolved/onSedResolved 让 banner 消失，用户其实
  // 没拿到更新命令却以为已处理完。现只在真正复制成功后才收口。
  const copyOne = (cmd: string) => {
    if (!cmd || !newIpValid) return;
    void copyText(
      cmd,
      () => {
        setCopiedCmd(cmd);
        onResolved(selectedIp);
        onSedResolved(); // 收口——复制远程更新命令后允许 banner 自然消失
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  // 折叠态细条：约 40px，保留入口；带「复制」按钮可一键复制，无需展开
  if (!expanded) {
    return (
      <div className="animate-fade-in flex items-stretch rounded-lg border border-destructive/35 bg-destructive/[0.08]">
        <button
          type="button"
          onClick={() => {
            autoCollapsed.current = true;
            setExpanded(true);
          }}
          className="flex flex-1 items-center gap-2 rounded-l-lg py-2 pl-3 pr-2 text-left"
          aria-label="展开提示"
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive text-xs font-bold">
            !
          </span>
          <span className="text-sm font-semibold text-destructive">检测到网络地址变化</span>
          <span className="text-xs text-muted-foreground">· 点击展开新连接命令</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            copyOne(entries[0].cmd);
          }}
          disabled={!newIpValid}
          className="shrink-0 rounded-md border border-destructive/30 bg-white px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          复制
        </button>
        <span className="grid place-items-center px-1 text-muted-foreground">▴</span>
        {onDismiss && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            aria-label="关闭提示"
            title="本次会话忽略此提示"
            className="grid h-auto w-7 place-items-center rounded-r-lg text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-foreground"
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="animate-fade-in relative space-y-3 rounded-lg border border-destructive/35 bg-destructive/[0.08] p-4">
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          title="本次会话忽略此提示"
          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-foreground"
        >
          <Icon name="close" size={14} />
        </button>
      )}
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
          <Icon name="alertTriangle" size={15} />
        </div>
        <div>
          <p className="text-sm font-semibold text-destructive">检测到网络地址变化</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              之前使用的 <code className="rounded bg-background px-1">{previousIp}</code> 已不在本机网卡列表中（大概率是
              网络重新连接后分配了新地址）。请在下方「选择远程服务器能连回本机的地址」中选中新地址，连接命令会自动更新，复制后到远程服务器执行即可原地更新 IP（无需重新授权）。
            </p>
            {!autoCollapsed.current && (
              <p className="mt-1.5 text-xs text-muted-foreground/80">
                {countdown} 秒后自动收起为细条 · 点细条可重新展开 · 点 × 可忽略
              </p>
            )}
          </div>
      </div>

      {newIpValid ? (
        <div className="pl-[38px] space-y-3">
          <p className="text-xs text-muted-foreground">
            已选中新地址，复制以下命令到远程服务器执行（原地更新 IP，不会重新授权）：
          </p>
          {entries.map((e, i) => (
            <div key={i} className="space-y-1.5">
              <p className="text-xs font-medium text-foreground/80">{e.label}</p>
              <CommandBlock
                command={e.cmd}
                copied={copiedCmd === e.cmd}
                onCopy={() => copyOne(e.cmd)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="pl-[38px] text-xs text-muted-foreground">
          在下方选一个新地址后，这里会自动生成「原地更新 IP」的远程命令。
        </p>
      )}
    </div>
  );
}
