import { Icon } from "../ui/icon";
import type { ChainSegment, SegmentTone } from "../../lib/serviceChain";
import { useChangeClass } from "../../hooks/useChangeClass";
import { NavTarget } from "../ui/NavTarget";
import { isWindows } from "../../lib/platform";

/**
 * 服务链路图：本机服务 → 防火墙（仅 Windows）→ 远程调用。
 *
 * 纯展示组件——状态判定全在 `lib/serviceChain.ts` 的 `computeChain()` 里（已单测）。
 * 这里只负责把 `ChainSegment[]` 画出来。
 *
 * 为何不用简单的三个彩色圆点：圆点只能说“通/不通”，而用户真正需要知道的是
 * **卡在哪一环**。连线的实/虚把“从哪里开始断的”直接画在了脸上。
 *
 * 卡内背景是深色渐变，所以色彩全走 white/透明度，不用语义色 token
 * （那些 token 是按白底调的，压在渐变上对比度不够）。
 */
/**
 * 三段各自的跳转目标。
 *
 * 「防火墙」指向设置页的 `set-firewall`（`FirewallGroup` 的卡级 id，与
 * `lib/settingsSearch.ts` 里那条同锚点）。**仅 Windows 有那张卡**，
 * 所以非 Windows 上这一段本来也不渲染，不存在点了跳空的情况。
 */
const SEG_NAV: Record<ChainSegment["key"], { tab: string; anchor?: string; title: string }> = {
  service: { tab: "settings", anchor: "set-network", title: "去设置查看监听端口与传输协议" },
  firewall: { tab: "settings", anchor: "set-firewall", title: "去设置查看防火墙规则" },
  remote: { tab: "log", title: "去日志页看远程调用明细" },
};

export function ServiceChain({
  segments,
  onNavigate,
  platform,
}: {
  segments: ChainSegment[];
  /** 三段各自可点。不传则退化为纯展示。 */
  onNavigate?: (tab: string, anchor?: string) => void;
  /** 仅用于一个守卫：非 Windows 上「防火墙」段不给跳转（那张卡不存在）。 */
  platform?: string;
}) {
  // 任一段状态变化 → 连线重播一次“从左生长”、节点弹一下。
  //
  // 为何用一个拼接签名而不是每段各调一次 hook：segments 长度是变的
  // （Windows 三段 / mac 两段），在循环里调 hook 会让调用次数随平台变——
  // 那是 Hooks 规则的硬伤。签名只需一次调用。
  const toneSig = segments.map((s) => s.tone).join("|");
  const grow = useChangeClass(toneSig, "chain-link--grow", 450);
  const nodePop = useChangeClass(toneSig, "chain-node--pop", 420);

  return (
    <div className="flex items-start" role="list" aria-label="服务链路状态">
      {segments.map((s, i) => (
        <NavTarget
          key={s.key}
          onNavigate={
            // 防火墙段在非 Windows 上没有落点，别给假的可点反馈。
            s.key === "firewall" && !isWindows(platform) ? undefined : onNavigate
          }
          tab={SEG_NAV[s.key].tab}
          anchor={SEG_NAV[s.key].anchor}
          title={SEG_NAV[s.key].title}
          className="chain-seg relative flex flex-1 flex-col items-center gap-1.5"
        >
          {/* 连线：画在本段与上一段之间，高度对齐节点圆心（节点 26px → 中心 13px）。
              上游不通就显虚线——一眼看出断点在哪。

              实线与虚线是**两个叠放的元素**，靠 opacity 交叉淡入而不是切 background：
              `repeating-linear-gradient` 与纯色之间无法插值，直接切就是硬变。 */}
          {i > 0 &&
            (() => {
              const broken = isBroken(segments[i - 1].tone) || isBroken(s.tone);
              return (
                <>
                  <span
                    aria-hidden="true"
                    className={`chain-link absolute top-[12px] h-0.5 ${grow} ${
                      broken ? "opacity-0" : "opacity-100"
                    }`}
                  />
                  <span
                    aria-hidden="true"
                    className={`chain-link chain-link--cut absolute top-[12px] h-0.5 ${
                      broken ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </>
              );
            })()}
          {/* 光晕只给**末段（远程调用）且已通**时用。为何不给所有 ok 节点：
              它是本页唯一的常驻动画，三个一起跳既吵也把开销乘三；
              而“远程真的在调用”才是这张卡最想表达的事。 */}
          <ChainNode
            tone={s.tone}
            pulse={s.key === "remote" && s.tone === "ok"}
            popClass={nodePop}
          />
          <span className="text-[10px] font-bold opacity-95">{s.name}</span>
          <span className="min-h-[13px] text-center text-[9.5px] leading-snug opacity-85">
            {s.detail}
          </span>
        </NavTarget>
      ))}
    </div>
  );
}

/** 上游是这些状态时，到下一段的连线应该是断的。unknown 不算断（只是没查到）。 */
function isBroken(tone: SegmentTone): boolean {
  return tone === "bad" || tone === "idle";
}

function ChainNode({
  tone,
  pulse = false,
  popClass = "",
}: {
  tone: SegmentTone;
  pulse?: boolean;
  popClass?: string;
}) {
  // 四种状态的字形各自有意义：
  //   ok      ✓ 白底绿字，最醒目
  //   bad     ✕ 白底红字，同样醒目——出了问题就要看得见
  //   unknown ? 半透明，**不能用绿也不能用红**：撞绿是谎报，报红是惊吓用户
  //   idle    – 半透明，中性空态（尚未发生 / 上游已断无从判定）
  const solid = tone === "ok" || tone === "bad";
  return (
    // 外层只负责定位：光晕绝对定位在它里，且写在节点**前面**——同层元素按文档
    // 顺序绘制，所以光晕在下、节点在上，扩散时不会遮住✓。
    <span className={`relative z-[1] grid h-[26px] w-[26px] place-items-center ${popClass}`}>
      {pulse && <span aria-hidden="true" className="chain-ripple" />}
      {solid ? (
        <span
          className={`relative grid h-full w-full place-items-center rounded-full bg-white/95 ${
            tone === "ok" ? "text-success" : "text-destructive"
          }`}
        >
          <Icon name={tone === "ok" ? "check" : "close"} size={15} />
        </span>
      ) : (
        <span className="relative grid h-full w-full place-items-center rounded-full bg-white/25 text-[13px] font-extrabold text-white">
          {tone === "unknown" ? "?" : "–"}
        </span>
      )}
    </span>
  );
}
