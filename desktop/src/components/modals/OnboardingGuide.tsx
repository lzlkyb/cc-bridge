import { useState, useEffect } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

const STORAGE_KEY = "cc-bridge-onboarding-done";

export function isOnboardingDone(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setOnboardingDone(): void {
  localStorage.setItem(STORAGE_KEY, "true");
}

const steps = [
  {
    icon: "folder" as const,
    title: "添加工作目录",
    desc: "在「安全」页添加白名单根目录，告诉 cc-bridge 远程可以访问哪些本地文件。这是安全防护的第一道防线。",
  },
  {
    icon: "plug" as const,
    title: "复制连接命令",
    desc: "切到「连接」页，选择合适的网络地址，复制连接命令。SSH 到远程 Linux 服务器上执行即可建立连接。",
  },
  {
    icon: "play" as const,
    title: "启动服务",
    desc: "点击 Hero 卡上的「启动服务」按钮开始监听。之后在远程服务器的 Claude Code 中就能直接读写本地文件了。",
  },
];

export function OnboardingGuide({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      setOnboardingDone();
      onClose();
    }
  };

  const handleSkip = () => {
    setOnboardingDone();
    onClose();
  };

  const current = steps[step];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleSkip}
    >
      <div
        className={`mx-4 w-full max-w-sm rounded-2xl border bg-card p-6 shadow-2xl transition-all duration-300 ${
          visible ? "translate-y-0 opacity-100 scale-100" : "translate-y-4 opacity-0 scale-95"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Step indicator dots */}
        <div className="mb-5 flex items-center justify-center gap-2">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-2 rounded-full transition-all duration-300 ${
                i === step ? "w-6 bg-primary" : i < step ? "w-2 bg-primary/40" : "w-2 bg-muted-foreground/25"
              }`}
            />
          ))}
        </div>

        {/* Icon */}
        <div className="mb-4 flex justify-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-accent">
            <Icon name={current.icon} size={32} className="text-primary" />
          </div>
        </div>

        {/* Content */}
        <h3 className="mb-2 text-center text-lg font-semibold">{current.title}</h3>
        <p className="mb-6 text-center text-sm leading-relaxed text-muted-foreground">
          {current.desc}
        </p>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            onClick={handleSkip}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            跳过引导
          </button>
          <Button size="sm" onClick={handleNext}>
            {step < steps.length - 1 ? "下一步" : "开始使用"}
          </Button>
        </div>
      </div>
    </div>
  );
}
