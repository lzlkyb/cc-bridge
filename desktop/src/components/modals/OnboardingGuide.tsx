import { useState, useEffect } from "react";
import type { StatusResponse } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { StepAddDir } from "./onboarding/StepAddDir";
import { StepPickAddress } from "./onboarding/StepPickAddress";
import { StepConnectCmd } from "./onboarding/StepConnectCmd";
import { StepTest } from "./onboarding/StepTest";

const STORAGE_KEY = "cc-bridge-onboarding-done";

export function isOnboardingDone(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setOnboardingDone(): void {
  localStorage.setItem(STORAGE_KEY, "true");
}

const steps = [
  { icon: "folder" as const, title: "添加工作目录" },
  { icon: "plug" as const, title: "选择连接地址" },
  { icon: "terminal" as const, title: "复制连接命令" },
  { icon: "check" as const, title: "测试连接" },
];

// H3：每步未完成时的轻量提示（软引导——仅提醒，不阻断继续）。
const stepHints = [
  "还没添加任何目录，AI 将无法读写你的文件",
  "建议先选一个远程能连回本机的地址",
  "记得复制连接命令到远程执行",
  "尚未测试连接（连不通常是 VPN / 防火墙，也可先开始使用）",
];

/**
 * 首次启动交互式向导（方案 A）：4 步帮用户真正走完接入流程——
 * ①添加本地目录 ②选远程连回地址 ③生成并复制连接命令 ④本机自检。
 * 复用 lib/utils 的命令纯函数与 App 层已有的 status / 选 IP 状态，不重造逻辑。
 *
 * H3 修复：
 * - 点遮罩不再永久关闭（误触代价高），改为轻微抖动提示“请用下方按钮”。
 * - 每步新增完成态：完成时标题右侧显“已完成”绿勾，未完成时底部给轻量提示（不强制拦）。
 * - 重新查看入口（设置页 / 命令面板）只打开本弹窗，不清 localStorage；走完或跳过时才写入。
 */
export function OnboardingGuide({
  status,
  selectedIp,
  onSelectIp,
  onRefresh,
  onClose,
}: {
  status?: StatusResponse;
  selectedIp: string;
  onSelectIp: (ip: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [shake, setShake] = useState(false);
  // H3：步骤③/④ 的完成态由子组件上报（复制过命令 / 自检通过）。
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = () => {
    setOnboardingDone();
    onClose();
  };

  const handleNext = () => {
    if (step < steps.length - 1) setStep(step + 1);
    else finish();
  };

  const handleSkip = () => finish();

  // H3：点遮罩不再永久关闭引导，仅轻微抖动提示改用下方按钮（跳过 / 下一步）。
  const handleOverlayClick = () => {
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  // H3：每步「完成条件」判定——仅用于显示完成态/提示，不拦截「下一步」（软引导）。
  const lanCount = status?.lanIps?.length ?? 0;
  const stepDone = (i: number): boolean => {
    switch (i) {
      case 0:
        return (status?.allowedRoots?.length ?? 0) > 0;
      case 1:
        // 无可用网卡时不拦（用户无从选择）。
        return !!selectedIp || lanCount === 0;
      case 2:
        return copiedCmd;
      case 3:
        return tested;
      default:
        return false;
    }
  };

  const current = steps[step];
  const currentDone = stepDone(step);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div
        className={`mx-4 flex max-h-[88vh] w-full max-w-md flex-col rounded-2xl modal-surface p-6 transition-all duration-300 ${
          visible ? "translate-y-0 opacity-100 scale-100" : "translate-y-4 opacity-0 scale-95"
        } ${shake ? "animate-shake" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-1 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-accent">
            <Icon name={current.icon} size={18} className="text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">首次使用引导</p>
            <h3 className="text-base font-semibold leading-tight">{current.title}</h3>
          </div>
          {currentDone && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
              <Icon name="check" size={12} /> 已完成
            </span>
          )}
        </div>

        {/* Step dots */}
        <div className="my-4 flex items-center justify-center gap-2">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step ? "w-6 bg-primary" : i < step ? "w-1.5 bg-primary/40" : "w-1.5 bg-muted-foreground/25"
              }`}
            />
          ))}
        </div>

        {/* Body（可滚动，容纳步骤内容）*/}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {step === 0 && <StepAddDir status={status} onRefresh={onRefresh} />}
          {step === 1 && (
            <StepPickAddress status={status} selectedIp={selectedIp} onSelectIp={onSelectIp} />
          )}
          {step === 2 && (
            <StepConnectCmd status={status} selectedIp={selectedIp} onCopied={() => setCopiedCmd(true)} />
          )}
          {step === 3 && (
            <StepTest status={status} selectedIp={selectedIp} onTested={() => setTested(true)} />
          )}
        </div>

        {/* H3：未完成时的轻量提示（不阻断继续）*/}
        {!currentDone && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-warning">
            <Icon name="info" size={13} className="shrink-0" />
            {stepHints[step]}
          </p>
        )}

        {/* Footer */}
        <div className="mt-5 flex items-center justify-between divider-x-top pt-4">
          <button
            onClick={handleSkip}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            跳过引导
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
                上一步
              </Button>
            )}
            <Button size="sm" onClick={handleNext}>
              {step < steps.length - 1 ? "下一步" : "开始使用"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
