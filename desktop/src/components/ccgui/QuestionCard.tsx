import { memo, useState } from "react";
import { buildAnswers } from "../../lib/ccReducer";
import type { CcApproval } from "../../lib/ccGuiTypes";
import { useExpiryCountdown } from "../../hooks/useExpiryCountdown";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/**
 * 提问卡（`AskUserQuestion`）。
 *
 * ## 为什么它和审批卡分开
 *
 * 审批是「放行 / 拒绝一个动作」，提问是「从选项里挑一个」。用同一张卡、只换文案
 * 会让用户以为点「允许」就是选第一个选项 —— 而真机上那样做，模型收到的是
 * 「用户没有回答」（`with_answers` 之前那版就是这么错的）。
 *
 * ## 答案怎么回去
 *
 * 拼成 `{问题文本: [选项 label…]}` 交给 Rust 侧并入 `updatedInput.answers`。
 * 键必须与 `questions[].question` 逐字相同，所以这里直接用题目文本当 key，
 * 不做任何规范化（Rust 侧按原文匹配，规范过反而对不上）。
 *
 * 一题都没选时「提交」不可点：空 answers 会被 Rust 拒掉，而把它当跳过处理
 * 又会让用户以为自己答了。两条路分开走，各自有明确的按钮。
 */
function QuestionCardImpl({
  approval,
  onSubmit,
  onSkip,
}: {
  approval: CcApproval;
  /** 已经筛掉空答案；至少有一项。 */
  onSubmit: (answers: Record<string, string[]>) => void;
  onSkip: () => void;
}) {
  const questions = approval.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const left = useExpiryCountdown(approval.expiresInSec);

  const toggle = (question: string, label: string, multi: boolean) => {
    setPicked((prev) => {
      const current = prev[question] ?? [];
      if (!multi) return { ...prev, [question]: [label] };
      return {
        ...prev,
        [question]: current.includes(label)
          ? current.filter((x) => x !== label)
          : [...current, label],
      };
    });
  };

  const answers = buildAnswers(questions, picked);
  const answered = Object.keys(answers).length;

  return (
    <div
      data-cc-entity
      className="overflow-hidden rounded-[10px] border border-warning/45 bg-warning/[.06]"
    >
      <div className="flex items-center gap-2 border-b border-warning/25 px-3 py-[6px]">
        <Icon name="message" size={12} className="shrink-0 text-warning-ink" />
        <span className="text-[12px] font-semibold text-warning-ink">CC 在问你</span>
        <span className="ml-auto shrink-0 text-[11px] text-warning-ink/80">
          {left}s 后自动跳过
        </span>
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-2">
        {/* 一道题都读不出来：只能跳过。画几个点不动的空卡比说清楚更糟。 */}
        {questions.length === 0 && (
          <p className="text-[11px] leading-[1.5] text-muted-foreground">
            这条提问没有给出可读的选项，在这里回答不了。跳过之后 CC 会自己决定。
          </p>
        )}
        {questions.map((q, qi) => {
          const multi = q.multiSelect === true;
          return (
            <div key={`${qi}:${q.question}`} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium leading-[1.5] text-foreground">
                {q.header && (
                  <span className="shrink-0 rounded-[4px] bg-warning/15 px-1.5 py-[1px] text-[10.5px] text-warning-ink">
                    {q.header}
                  </span>
                )}
                <span className="min-w-0 break-words">{q.question}</span>
                {multi && (
                  <span className="shrink-0 text-[10.5px] font-normal text-muted-foreground">
                    可多选
                  </span>
                )}
              </div>

              {/* 没有可选项目时不画空白：直接说明，让用户走跳过。 */}
              {q.options.length === 0 ? (
                <p className="text-[11px] leading-[1.5] text-muted-foreground">
                  这条问题没给选项，只能跳过让它自己决定。
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {q.options.map((o, oi) => {
                    const on = (picked[q.question] ?? []).includes(o.label);
                    return (
                      <button
                        key={`${oi}:${o.label}`}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(q.question, o.label, multi)}
                        className={`flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                          on
                            ? "border-primary/50 bg-primary/[.08]"
                            : "border-border bg-card/60 hover:border-primary/30"
                        }`}
                      >
                        <span
                          className={`mt-[2px] flex h-[13px] w-[13px] shrink-0 items-center justify-center border ${
                            multi ? "rounded-[3px]" : "rounded-full"
                          } ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                        >
                          {on && <Icon name="check" size={9} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11.5px] font-medium leading-[1.5] text-foreground">
                            {o.label}
                          </span>
                          {o.description && (
                            <span className="block text-[11px] leading-[1.45] text-muted-foreground">
                              {o.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 px-3 pb-2">
        <span className="mr-auto shrink-0 text-[11px] text-muted-foreground">
          {questions.length > 1 ? `${answered}/${questions.length} 已选` : ""}
        </span>
        <Button variant="outline" size="sm" className="h-7 px-3 text-[12px]" onClick={onSkip}>
          跳过
        </Button>
        <Button
          size="sm"
          className="h-7 px-3 text-[12px]"
          disabled={answered === 0}
          onClick={() => onSubmit(answers)}
        >
          提交
        </Button>
      </div>
    </div>
  );
}

export const QuestionCard = memo(QuestionCardImpl);
