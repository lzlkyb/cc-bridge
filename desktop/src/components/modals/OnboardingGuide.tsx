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

/**
 * 首次启动交互式向导（方案 A）：4 步帮用户真正走完接入流程——
 * ①添加本地目录 ②选远程连回地址 ③生成并复制连接命令 ④本机自检。
 * 复用 lib/utils 的命令纯函数与 App 层已有的 status / 选 IP 状态，不重造逻辑。
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

  const current = steps[step];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleSkip}
    >
      <div
        className={`mx-4 flex max-h-[88vh] w-full max-w-md flex-col rounded-2xl border bg-card p-6 shadow-2xl transition-all duration-300 ${
          visible ? "translate-y-0 opacity-100 scale-100" : "translate-y-4 opacity-0 scale-95"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-1 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-accent">
            <Icon name={current.icon} size={18} className="text-primary" />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">首次使用引导</p>
            <h3 className="text-base font-semibold leading-tight">{current.title}</h3>
          </div>
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
          {step === 2 && <StepConnectCmd status={status} selectedIp={selectedIp} />}
          {step === 3 && <StepTest status={status} selectedIp={selectedIp} />}
        </div>

        {/* Footer */}
        <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
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
