import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/icon";

/** 17 个工具的简体中文短名（热门工具 Top3 展示用，避免裸英文）。 */
export const TOOL_LABELS: Record<string, string> = {
  read_files: "读取文件",
  write_files: "写入文件",
  edit_files: "编辑文件",
  list_directory: "列目录",
  create_directory: "建目录",
  remove_directory: "删目录",
  delete_files: "删文件",
  move_files: "移动",
  copy_files: "复制",
  search_files: "搜索",
  run_command: "执行命令",
  get_command_output: "读输出",
  stop_command: "停止命令",
  analyze_file: "分析文件",
  notebook_edit: "编辑笔记本",
  list_allowed_roots: "白名单",
  batch: "批量",
};

/**
 * 值变化弹跳：返回触发 `hero-metric-pop` 动画的 className。
 * 内部追踪上次值，变化时在 300ms 内闪一下 scale 1→1.08→1。
 */
export function usePopClass(value: string | number): string {
  const prev = useRef(value);
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setPop(true);
      const t = setTimeout(() => setPop(false), 300);
      return () => clearTimeout(t);
    }
  }, [value]);
  return pop ? "hero-metric-pop" : "";
}

/** 核心性能网格单元（2×3 用）：图标 + 大数字 + 标签 + 可选副文案。 */
export function HeroStat({
  icon,
  label,
  value,
  sub,
}: {
  icon: IconName;
  label: string;
  value: string | number;
  sub?: string;
}) {
  const pop = usePopClass(value);
  return (
    <div className="hero-metric">
      <div className={`hero-val-sm font-extrabold leading-tight tracking-tight ${pop}`}>
        {value}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] opacity-85">
        <Icon name={icon} size={12} />
        {label}
      </div>
      {sub && <div className="text-[9px] leading-none opacity-65 mt-0.5">{sub}</div>}
    </div>
  );
}

/** 健康度环：渐变弧线 + 中心状态字（优/良/注意/异常/停）。 */
export function HealthRing({ rate, running }: { rate: number; running: boolean }) {
  const C = 2 * Math.PI * 18; // ~113.1
  const offset = C * (1 - Math.min(100, Math.max(0, rate)) / 100);
  const label = !running
    ? "停"
    : rate >= 99.5
      ? "优"
      : rate >= 98
        ? "良"
        : rate >= 90
          ? "注意"
          : "异常";
  return (
    <svg width="42" height="42" viewBox="0 0 42 42" className="shrink-0">
      <defs>
        <linearGradient id="heroHealthGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#818CF8" />
          <stop offset="1" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
        <circle
          cx="21"
          cy="21"
          r="18"
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="4"
      />
        <circle
          cx="21"
          cy="21"
          r="18"
        fill="none"
        stroke="url(#heroHealthGrad)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={offset}
        transform="rotate(-90 21 21)"
      />
        <text x="21" y="25" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="800">
          {label}
        </text>
    </svg>
  );
}

/** 治理条 / 热门工具的胶囊（带图标 + 数值）。 */
export function HeroChip({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string | number;
}) {
  return (
    <span className="hero-pill">
      <Icon name={icon} size={12} />
      {label} <b>{value}</b>
    </span>
  );
}
