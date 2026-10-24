import { Icon } from "../ui/icon";
import type { CcProbe } from "../../lib/ccEventTypes";

/** 首次进入的示例 prompt。都是「一眼能看懂 CC 会干什么」的短句。 */
const PROMPTS = [
  "看一下这个项目的结构，告诉我它是干什么的",
  "跑一下测试，把失败的用例列出来",
  "找出最近改过但没写注释的函数",
];

/**
 * 空状态。
 *
 * 🔴 这里必须能显示「为什么不能用」：CLI 没装、远端 PATH 里没找到、SSH 没开……
 * 这些是用户第一次进这一页时**唯一**会遇到的问题，藏起来只会让人反复点发送
 * 而看不出任何反应。所以 `probe.found === false` 时直出说明 + 重试按钮。
 */
export function CcEmptyState({
  probe,
  probing,
  onRetryProbe,
  onSend,
  cwd,
  onCwdChange,
  cwdEditable,
}: {
  probe: CcProbe | null;
  probing: boolean;
  onRetryProbe: () => void;
  onSend: (text: string) => void;
  cwd: string;
  onCwdChange: (v: string) => void;
  /** 远端模式下工作目录由远端 shell 决定，本机才可编辑。 */
  cwdEditable: boolean;
}) {
  const missing = probe !== null && !probe.found;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon name={missing ? "alertTriangle" : "sparkles"} size={18} />
      </span>

      {missing ? (
        <div className="flex max-w-[420px] flex-col items-center gap-2">
          <p className="text-[13px] font-semibold text-foreground">还没法开始</p>
          <p className="text-[11.5px] leading-[1.6] text-muted-foreground">{probe.message}</p>
          <button
            type="button"
            onClick={onRetryProbe}
            disabled={probing}
            className="mt-1 rounded-lg border border-border px-3 py-1 text-[12px] text-foreground transition-colors hover:border-primary/40 disabled:opacity-50"
          >
            {probing ? "探测中…" : "重新探测"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-[13px] font-semibold text-foreground">问 CC 点什么</p>
            <p className="text-[11px] text-muted-foreground">
              {probe?.version ? `claude ${probe.version}` : "直接对话，工具调用会显示在下面"}
            </p>
          </div>

          <div className="mt-1 flex flex-col items-stretch gap-1.5">
            {PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onSend(p)}
                title={p}
                data-cc-inset
                className="max-w-[420px] truncate rounded-lg border border-border bg-card px-3 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {p}
              </button>
            ))}
          </div>

          <label className="mt-2 flex w-full max-w-[420px] flex-col items-start gap-1 text-left">
            <span className="text-[10.5px] text-muted-foreground">
              工作目录{cwdEditable ? "" : "（远端，由远端 shell 决定）"}
            </span>
            <input
              value={cwd}
              onChange={(e) => onCwdChange(e.target.value)}
              disabled={!cwdEditable}
              spellCheck={false}
              placeholder={cwdEditable ? "留空 = 家用目录" : "留空 = 登录目录"}
              data-cc-inset
              className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none transition-colors focus:border-primary/40 disabled:opacity-60"
            />
          </label>
        </>
      )}
    </div>
  );
}
