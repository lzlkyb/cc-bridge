import type { StaticStatus } from "../../../lib/types";
import type { ConnectGuideState, GuideSection } from "../../../hooks/useConnectGuideState";
import { useAutoAnimateRM } from "../../../hooks/useAutoAnimateRM";
import { useAutoScrollOnExpand } from "../../../hooks/useAutoScrollOnExpand";
import { Icon } from "../../ui/icon";
import { AddressPicker } from "./AddressPicker";
import { OptionCard } from "./widgets";
import { GlobalSteps, ProjectSteps } from "./Steps";
import { TokenManager } from "../TokenManager";
import { PermissionCard } from "./PermissionCard";

/**
 * 接入向导正文（Claude Code 分支；多工具分流由外层 ToolGuide 负责）。
 *
 * 自 ConnectTab.tsx 独立成文件：原来 18 个 props 逐个透传，现在向导局部状态整体
 * 收进 useConnectGuideState（`guide` 一个对象），收敛为 8 个 props——
 * `status`（只读透传）+ `guide`（hook 返回值整体）+ 地址选择三件套
 * （listenAll/lanIps/selectedIp/onSelectIp）+ `onToggle`/`onRefresh`。
 *
 * 卡片外壳（标题 + 四工具选择器）由 ToolGuide 渲染，本组件只出 claude-code 内容。
 * 区块展开仍为单选聚焦：展开一块时其余收起，与升级前行为一致。
 */
export function ConnectGuide({
  status,
  guide,
  listenAll,
  lanIps,
  selectedIp,
  onSelectIp,
  onToggle,
  onRefresh,
}: {
  status?: StaticStatus;
  /** useConnectGuideState 返回值整体（scope/命令/展开态/复制反馈……）。 */
  guide: ConnectGuideState;
  listenAll: boolean;
  lanIps: string[];
  selectedIp: string;
  onSelectIp: (ip: string) => void;
  onToggle: (s: GuideSection) => void;
  onRefresh: () => void;
}) {
  const isOpen = (k: GuideSection) => guide.expanded === k;
  const scopeOpen = isOpen("scope");
  const stepsOpen = isOpen("steps");
  const permOpen = isOpen("perm");
  const scopeBody = useAutoAnimateRM<HTMLDivElement>();
  const stepsBody = useAutoAnimateRM<HTMLDivElement>();
  const permBody = useAutoAnimateRM<HTMLDivElement>();
  // 首屏不自动滚动（hook 内置挂载守卫）；仅用户主动展开对应块时才平滑滚动到该块。
  const scopeBtn = useAutoScrollOnExpand<HTMLButtonElement>(scopeOpen);
  const stepsBtn = useAutoScrollOnExpand<HTMLButtonElement>(stepsOpen);
  const permBtn = useAutoScrollOnExpand<HTMLButtonElement>(permOpen);

  return (
    <>
      {listenAll && lanIps.length > 0 && (
        <div className="guide-block guide-block--raw">
          <AddressPicker
            ips={lanIps}
            selected={selectedIp}
            onSelect={onSelectIp}
            healthCheck={guide.healthCheck}
            port={guide.port}
            onRefresh={onRefresh}
          />
        </div>
      )}
      <div className="guide-block">
        <button
          type="button"
          onClick={() => onToggle("scope")}
          className="collapsible-head w-full text-left"
          aria-expanded={scopeOpen}
          ref={scopeBtn}
        >
          <span className="step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-primary to-primary/70">
            <Icon name="sliders" size={14} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="ui-h-sub text-foreground">接入模式</div>
            {!scopeOpen && (
              <div className="text-[11px] text-muted-foreground">
                {guide.scope === "project" ? "项目级 · 仅指定项目生效" : "全局模式 · 所有项目可用"}
              </div>
            )}
          </div>
          <Icon
            name="chevronDown"
            size={16}
            className={`collapsible-chev ${scopeOpen ? "open" : ""}`}
            aria-hidden="true"
          />
        </button>
        <div ref={scopeBody}>
          {scopeOpen && (
            <div className="collapsible-body pl-9">
              <div className="grid grid-cols-2 gap-3">
                {([
                  { key: "project", title: "项目级", desc: "仅指定项目生效", badge: "推荐" as const },
                  { key: "user", title: "全局模式", desc: "一次配置，所有项目都能使用" },
                ] as const).map((o) => (
                  <OptionCard key={o.key} selected={guide.scope === o.key} title={o.title} desc={o.desc}
                    badge={"badge" in o ? o.badge : undefined} onClick={() => guide.setScope(o.key)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="my-3.5 h-px bg-border guide-divider" />
      <div className="guide-block">
        <button
          type="button"
          onClick={() => onToggle("steps")}
          className="collapsible-head w-full text-left"
          aria-expanded={stepsOpen}
          ref={stepsBtn}
        >
          <span className="step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-primary to-primary/70">
            <Icon name="terminal" size={14} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="ui-h-sub text-foreground">
              接入步骤
              <span className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${status?.transport === "sse" ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200" : "bg-indigo-50 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-200"}`}>
                {status?.transport === "sse" ? "SSE 流式" : "HTTP"}
              </span>
            </div>
            {!stepsOpen && (
              // ① P0 峰值时刻：远程首次调用成功（totalRequests 0→1 事件）时摘要换文案，
              // aria-live 让读屏用户也能听到「配置生效」的确认。
              <div className="text-[11px] text-muted-foreground" aria-live="polite">
                {guide.firstCallSeen ? "✓ 已收到首次调用，配置生效" : "点击展开查看连接命令"}
              </div>
            )}
          </div>
          <Icon
            name="chevronDown"
            size={16}
            className={`collapsible-chev ${stepsOpen ? "open" : ""}`}
            aria-hidden="true"
          />
        </button>
        <div ref={stepsBody}>
          {stepsOpen && (
            <div className="collapsible-body pl-9">
              {guide.scope === "user" ? (
                <GlobalSteps command={guide.connectCommand} copied={guide.isCopied("connect")} onCopy={guide.copyConnect} />
              ) : (
                <ProjectSteps command={guide.connectCommand} copied={guide.isCopied("connect")} onCopy={guide.copyConnect}
                  projectPath={guide.projectPath} setProjectPath={guide.setProjectPath} />
              )}
            </div>
          )}
        </div>
      </div>
      <div className="my-3.5 h-px bg-border guide-divider" />
      <div className="guide-block">
        <TokenManager status={status} onRefresh={onRefresh} projectPath={guide.projectPath}
          expanded={isOpen("token")} onToggle={() => onToggle("token")} />
      </div>
      <div className="guide-block">
        <button
          type="button"
          onClick={() => onToggle("perm")}
          className="collapsible-head w-full text-left"
          aria-expanded={permOpen}
          ref={permBtn}
        >
          <span className="step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-emerald-500 to-emerald-600">
            <Icon name="check" size={14} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="ui-h-sub text-foreground">权限自动授权</div>
            {!permOpen && (
              <div className="text-[11px] text-muted-foreground">点击展开查看授权命令</div>
            )}
          </div>
          <Icon
            name="chevronDown"
            size={16}
            className={`collapsible-chev ${permOpen ? "open" : ""}`}
            aria-hidden="true"
          />
        </button>
        <div ref={permBody}>
          {permOpen && (
            <div className="collapsible-body pl-9">
              <PermissionCard scope={guide.scope} projectPath={guide.projectPath}
                includeShellTools={guide.includeShellTools} setIncludeShellTools={guide.setIncludeShellTools}
                permissionCommand={guide.permissionCommand} permCopied={guide.isCopied("perm")} handlePermCopy={guide.copyPerm} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
