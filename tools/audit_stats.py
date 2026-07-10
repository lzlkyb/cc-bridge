#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统计 cc-bridge 审计日志 (audit.log, JSONL 每行一条) 中每次工具调用的服务端耗时分布。

背景
----
audit.log 由 desktop/src-tauri/src/audit.rs 写入，每条记录含:
  - tool       工具名 (read_files / write_files / edit_files / ...)
  - success    是否成功
  - durationMs 服务端处理耗时 (**只包住 dispatch_tool, 不含后面那次同步审计写**, 见 http.rs)
  - sourceIp / timestamp / params / error

durationMs 是「服务端耗时」的下界:
  - 普遍很小 (几~十几 ms) 但仍觉得慢  -> 瓶颈是网络 RTT (架构层, 需减少往返)
  - 偏大 (几十~几百 ms)              -> 服务端同步阻塞 (D7 审计写盘 / 写路径备份 copy+prune)

用法
----
  # 自动在 Tauri app-data 目录里找 audit.log (Roaming/Local 下 com.ccbridge.desktop 与 cc-bridge)
  python audit_stats.py

  # 显式指定日志路径
  python audit_stats.py --path "C:\\Users\\me\\AppData\\Roaming\\com.ccbridge.desktop\\audit.log"

  # 只看某个日期之后的调用 (按 timestamp 前缀, 如 2026-07-01)
  python audit_stats.py --since 2026-07-01

  # 打印耗时最高的 N 条样本 (用于定位具体慢工具/慢文件)
  python audit_stats.py --top 20

  # 只看失败调用
  python audit_stats.py --only-errors

纯标准库实现, 无需 pip install。
"""

import argparse
import glob
import json
import os
import statistics
import sys


# cc-bridge 的 Tauri 配置: identifier = com.ccbridge.desktop, productName = cc-bridge
IDENTIFIER = "com.ccbridge.desktop"
PRODUCT = "cc-bridge"


def candidate_log_paths():
    """枚举 Tauri 在 Windows 上可能的 app-data 目录, 返回其中 audit.log 的候选路径。"""
    roots = []
    for env in ("APPDATA", "LOCALAPPDATA"):
        p = os.environ.get(env)
        if p:
            roots.append(p)
    # 兜底: 常见硬编码位置
    home = os.path.expanduser("~")
    roots += [
        os.path.join(home, "AppData", "Roaming"),
        os.path.join(home, "AppData", "Local"),
    ]

    names = {IDENTIFIER, PRODUCT}
    paths = []
    seen = set()
    for root in roots:
        for name in names:
            d = os.path.join(root, name)
            cand = os.path.join(d, "audit.log")
            if cand not in seen:
                seen.add(cand)
                paths.append(cand)
    return paths


def discover_log():
    for p in candidate_log_paths():
        if os.path.isfile(p):
            return p
    return None


def percentile(sorted_vals, p):
    """最近秩百分位 (linear interpolation)。sorted_vals 必须已升序且非空。"""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    k = (len(sorted_vals) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return float(sorted_vals[f])
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def load_entries(path, since=None, only_errors=False):
    entries = []
    skipped = 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            ts = obj.get("timestamp", "")
            if since and isinstance(ts, str) and ts[:10] < since:
                continue
            if only_errors and obj.get("success", True):
                continue
            entries.append(obj)
    return entries, skipped


def summarize(title, durations):
    if not durations:
        print(f"  [{title}] 无带 durationMs 的样本")
        return
    d = sorted(durations)
    n = len(d)
    print(f"  [{title}] 样本数={n}")
    print(f"    min={d[0]:.0f}  max={d[-1]:.0f}  mean={statistics.fmean(d):.1f}  median={statistics.median(d):.1f}")
    for p in (50, 90, 95, 99):
        print(f"    p{p:02d}={percentile(d, p):.1f} ms")


def main():
    ap = argparse.ArgumentParser(description="统计 cc-bridge audit.log 的 durationMs 分布")
    ap.add_argument("--path", help="audit.log 路径 (缺省自动在 Tauri app-data 目录查找)")
    ap.add_argument("--since", help="只统计该日期之后的调用, 如 2026-07-01")
    ap.add_argument("--top", type=int, default=0, help="打印耗时最高的 N 条样本")
    ap.add_argument("--only-errors", action="store_true", help="只看失败调用")
    args = ap.parse_args()

    path = args.path or discover_log()
    if not path or not os.path.isfile(path):
        print("未找到 audit.log。")
        print("已搜索以下候选路径:")
        for p in candidate_log_paths():
            print("  - " + p)
        print("\n请显式指定: python audit_stats.py --path <audit.log 的完整路径>")
        return 1

    print(f"读取: {path}\n")
    entries, skipped = load_entries(path, since=args.since, only_errors=args.only_errors)
    print(f"解析到 {len(entries)} 条记录" + (f" (跳过 {skipped} 行无法解析)" if skipped else ""))

    total = len(entries)
    ok = sum(1 for e in entries if e.get("success"))
    fail = total - ok
    with_ms = [e["durationMs"] for e in entries if isinstance(e.get("durationMs"), (int, float))]
    missing = total - len(with_ms)

    print(f"成功={ok}  失败={fail}  缺 durationMs={missing}\n")

    print("== 总体耗时分布 (ms) ==")
    summarize("全部", with_ms)

    # 按工具分组
    by_tool = {}
    for e in entries:
        if not isinstance(e.get("durationMs"), (int, float)):
            continue
        by_tool.setdefault(e.get("tool", "<unknown>"), []).append(e["durationMs"])

    print("\n== 按工具分组 (count / p50 / p95, ms) ==")
    print(f"  {'tool':<22}{'count':>8}{'p50':>10}{'p95':>10}")
    for tool in sorted(by_tool, key=lambda t: -len(by_tool[t])):
        d = sorted(by_tool[tool])
        print(f"  {tool:<22}{len(d):>8}{percentile(d,50):>10.1f}{percentile(d,95):>10.1f}")

    # 耗时最高的样本
    if args.top and args.top > 0:
        ranked = [
            e for e in entries
            if isinstance(e.get("durationMs"), (int, float))
        ]
        ranked.sort(key=lambda e: e["durationMs"], reverse=True)
        print(f"\n== 耗时最高的 {min(args.top, len(ranked))} 条 ==")
        for e in ranked[: args.top]:
            params = e.get("params", "")
            if isinstance(params, str) and len(params) > 80:
                params = params[:80] + "..."
            print(f"  {e['durationMs']:>7.0f} ms  {e.get('tool','?'):<20} ok={e.get('success')}  {params}")

    # 结论提示
    if with_ms:
        p95 = percentile(sorted(with_ms), 95)
        print("\n== 结论提示 ==")
        if p95 < 20:
            print(f"  p95={p95:.1f} ms 很小 -> 瓶颈大概率在网络 RTT (架构层), 优先减少往返:")
            print("    批量读 files[] / 并行工具调用 / multi_edit / 把工作树拉近 (同步)。")
        elif p95 < 100:
            print(f"  p95={p95:.1f} ms 中等 -> 混合因素, 建议两侧都看:")
            print("    服务端先做 P0(审计异步写 D7 + 写路径备份 spawn_blocking), 同时减少往返。")
        else:
            print(f"  p95={p95:.1f} ms 偏大 -> 服务端处理慢, 优先实现 P0:")
            print("    A. 审计写盘改后台 channel (修 D7); B. 写路径备份 copy/prune 丢 spawn_blocking。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
