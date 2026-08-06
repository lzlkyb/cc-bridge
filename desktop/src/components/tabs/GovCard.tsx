import type { StaticStatus } from "../../lib/types";
import { Icon } from "../ui/icon";
import { NavTarget } from "../ui/NavTarget";

/**
 * 九个治理胶囊各自的跳转目标。
 *
 * 🔴 **anchor 全部取自 `lib/settingsSearch.ts`**（命令面板用的同一批），不另起一套。
 * 那个文件有测试锁着「设置页条目必须带 anchor」，跟着它走就不会跑偏；
 * 若哪天设置页重构改了 DOM id，两处会一起发现、一起改。
 *
 * 白名单那条指向**安全页**而不是设置页的开关：胶囊文案是「路径白名单 · N 目录」，
 * 用户点它想管的是目录，而目录管理在安全页（settingsSearch 里 `set-roots` 也是这么定的）。
 */
const NAV = {
  roots: { tab: "security", title: "去安全页管理白名单目录" },
  audit: { tab: "settings", anchor: "audit", title: "去设置调整审计日志" },
  ratelimit: { tab: "settings", anchor: "ratelimit", title: "去设置调整限流" },
  backup: { tab: "settings", anchor: "backup", title: "去设置调整写备份" },
  encoding: { tab: "settings", anchor: "encoding", title: "去设置调整读取编码自适应" },
  readonly: { tab: "settings", anchor: "readonly", title: "去设置调整只读模式" },
  shell: { tab: "settings", anchor: "shell", title: "去设置调整命令执行" },
  session: { tab: "settings", anchor: "session-persist", title: "去设置调整命令会话持久化" },
} as const;

/**
 * 安全治理卡。只读 `StaticStatus`——不含高频字段，所以它**不会随 5s 轮询重渲**。
 *
 * 标题右侧的“推荐状态”只在四道防线全开时才给——不能因为“大部分开了”就撞绿。
 */
export function GovCard({
  status,
  onNavigate,
}: {
  status?: StaticStatus;
  /**
   * 🔴 本卡**不整卡可点**：九个胶囊各自指向不同的设置项，
   * 整卡只能共用一个目标，那等于把信息量丢掉八成。
   */
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  if (!status) return <div className="bento-card" />;

  const roots = status.allowedRoots.length;
  const windowSec = Math.round(status.rateLimit.windowMs / 1000);
  // 四道基础防线。命令执行 / 只读模式是可选项，不算在“推荐”里。
  const recommended =
    status.whitelistEnabled && status.auditEnabled && status.rateLimitEnabled && status.backupEnabled;

  return (
    <div className="bento-card">
      <div className="bento-eyebrow">
        安全治理
        <span
          className={`ml-auto text-[10px] font-bold normal-case tracking-normal ${
            recommended ? "text-success" : "text-warning"
          }`}
        >
          {recommended ? "推荐状态 ✓" : "有防线未开"}
        </span>
      </div>
      {/* flex-1 + content-end：同样是为了吃掉网格摊过来的多余高度（见 HealthCard 注释）。 */}
      {/* flex-1 + content-end：同样是为了吃掉网格摊过来的多余高度（见 HealthCard 注释）。 */}
      <div className="mt-2 flex flex-1 flex-wrap content-end gap-1.5">
        <Pill
          on={status.whitelistEnabled}
          text={`路径白名单 · ${roots} 目录`}
          onNavigate={onNavigate}
          {...NAV.roots}
        />
        <Pill on={status.auditEnabled} text="审计日志" onNavigate={onNavigate} {...NAV.audit} />
        <Pill
          on={status.rateLimitEnabled}
          text={`限流 ${status.rateLimit.maxRequests}次/${windowSec}秒`}
          onNavigate={onNavigate}
          {...NAV.ratelimit}
        />
        <Pill
          on={status.backupEnabled}
          text={`写备份 ${status.backupCount} 份`}
          onNavigate={onNavigate}
          {...NAV.backup}
        />
        <Pill
          on={status.encodingDetectEnabled}
          text="编码探测"
          onNavigate={onNavigate}
          {...NAV.encoding}
        />
        {/* 备份保留份数：纯配置值，不是开关，所以永远中性色。 */}
        <Pill
          on={false}
          text={`每文件保留 ${status.backupRetention} 份`}
          onNavigate={onNavigate}
          {...NAV.backup}
        />
        {/* 下三项是“开了才需要留神”的项：传进去的 on 已取过反，
            配上 warnWhenOn 后——开启时报警色，关闭是中性。 */}
        <Pill
          on={!status.readonlyMode}
          warnWhenOn
          text={`只读模式 ${status.readonlyMode ? "开" : "关"}`}
          onNavigate={onNavigate}
          {...NAV.readonly}
        />
        <Pill
          on={!status.shellEnabled}
          warnWhenOn
          text={`命令执行 ${status.shellEnabled ? `开 · ${status.shellType}` : "关"}`}
          onNavigate={onNavigate}
          {...NAV.shell}
        />
        <Pill
          on={!status.sessionCwdEnabled}
          warnWhenOn
          text={`会话持久化 ${status.sessionCwdEnabled ? "开" : "关"}`}
          onNavigate={onNavigate}
          {...NAV.session}
        />
      </div>
    </div>
  );
}

/**
 * 治理胶囊。
 *
 * `on=true` → 绿色带 ✓；`on=false` → 中性灰。
 * `warnWhenOn` 用于“只读模式 / 命令执行”这种反语义项：传进来的 `on` 已经取过反，
 * false 意味着“该留神的项被打开了”，此时用警色而不是灰色。
 */
function Pill({
  on,
  text,
  warnWhenOn,
  onNavigate,
  tab,
  anchor,
  title,
}: {
  on: boolean;
  text: string;
  warnWhenOn?: boolean;
  onNavigate?: (tab: string, anchor?: string) => void;
  tab: string;
  anchor?: string;
  title: string;
}) {
  const cls = on ? "gov-pill gov-pill--ok" : warnWhenOn ? "gov-pill gov-pill--warn" : "gov-pill";
  return (
    <NavTarget onNavigate={onNavigate} tab={tab} anchor={anchor} title={title} className={cls}>
      {on && <Icon name="check" size={11} />}
      {text}
    </NavTarget>
  );
}
