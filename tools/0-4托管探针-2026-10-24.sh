#!/bin/bash
# 0-4 托管探针（2026-10-24）：关窗 / SSH 断线后，远端任务能不能继续跑、重连能不能接回。
#
# 用法：scp 到远端 Linux，分两段跑——
#   第一段：bash 0-4托管探针-2026-10-24.sh 1     # 起任务，然后立刻断开 SSH
#   第二段：bash 0-4托管探针-2026-10-24.sh 2     # 重连后验证
# 两段之间必须真的断开 SSH（关窗口 / kill ssh 进程），只在原会话里等着不算。
#
# 判据：
#   A. tmux 分支——断线期间日志时间戳是否继续增长；attach 能否恢复交互态
#   B. setsid 分支——进程 SID 是否等于自己的 PID（脱离父进程）；断线后是否存活
#   C. 有 claude 时才跑的分支——claude 在 tmux 里跑 --print 长任务，断线后是否跑完

PHASE="${1:-1}"
TMUX_LOG=/tmp/ccprobe-tmux.log
SETSID_LOG=/tmp/ccprobe-setsid.log

phase1() {
  echo "=== 环境 ==="
  for c in tmux setsid claude; do
    if command -v "$c" >/dev/null 2>&1; then echo "  $c: $(command -v $c)"; else echo "  $c: 缺失"; fi
  done
  tmux -V 2>&1 | sed 's/^/  /'

  echo
  echo "=== [A] tmux：起 60s 长任务 ==="
  if ! command -v tmux >/dev/null 2>&1; then
    echo "  tmux 缺失，本分支跳过（远端 Linux 上应有）"
  else
    tmux kill-session -t ccprobe 2>/dev/null
    rm -f "$TMUX_LOG"
    tmux new-session -d -s ccprobe "bash -c 'echo start:\$(date +%s) > $TMUX_LOG; for i in \$(seq 1 60); do echo tick \$i \$(date +%s) >> $TMUX_LOG; sleep 1; done; echo done:\$(date +%s) >> $TMUX_LOG'"
    sleep 2
    echo "  会话：$(tmux list-sessions 2>&1)"
    echo "  日志开头："; head -2 "$TMUX_LOG" 2>&1 | sed 's/^/    /'
  fi

  echo
  echo "=== [B] setsid：起 60s 长任务（无 tmux 时的兜底路线） ==="
  if ! command -v setsid >/dev/null 2>&1 || ! command -v pgrep >/dev/null 2>&1; then
    echo "  setsid/pgrep 缺失，本分支跳过（远端 Linux 上应有）"
  else
    rm -f "$SETSID_LOG"
    setsid bash -c "for i in \$(seq 1 60); do echo tick \$i \$(date +%s) >> $SETSID_LOG; sleep 1; done" >/dev/null 2>&1 </dev/null &
    sleep 2
    # setsid 的子 shell：日志路径不在命令行里，用 seq 抓
    local pid
    pid=$(pgrep -f 'seq 1 60' | head -1)
    if [ -n "$pid" ]; then
      echo "  PID $pid 的进程树（SID 应等于自己的 PID 才算脱离父进程）："
      ps -o pid,ppid,sid,cmd -p "$pid" 2>&1 | sed 's/^/    /'
    else
      echo "  没抓到进程（可能已结束）"
    fi
    echo "  日志开头："; head -2 "$SETSID_LOG" 2>&1 | sed 's/^/    /'
  fi

  echo
  echo "=== [C] claude（缺失则跳过，A/B 结论仍有效） ==="
  if command -v tmux >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
    tmux kill-session -t ccclaude 2>/dev/null
    rm -f /tmp/ccprobe-claude.log
    tmux new-session -d -s ccclaude "bash -c 'claude --print \"用三句话介绍 tmux\" > /tmp/ccprobe-claude.log 2>&1; echo exit:\$? >> /tmp/ccprobe-claude.log'"
    echo "  已在 tmux 里起 claude --print，日志 /tmp/ccprobe-claude.log"
  else
    echo "  跳过：需要 tmux 与 claude 同时存在（当前 tmux=$(command -v tmux || echo 缺失) claude=$(command -v claude || echo 缺失)）"
  fi

  echo
  echo ">>> 现在立刻断开 SSH（关窗口或 kill ssh），等 90 秒以上，再跑第二段 <<<"
  echo ">>> 断开时刻记一下：$(date +%s) <<<"
}

phase2() {
  echo "=== 重连后：任务是否还活着 ==="
  echo "  当前时间戳：$(date +%s)"
  echo
  echo "--- [A] tmux 日志（应跨过你断开的时刻继续增长） ---"
  if [ -f "$TMUX_LOG" ]; then
    echo "  共 $(wc -l < "$TMUX_LOG") 行"; head -1 "$TMUX_LOG" | sed 's/^/  首 /'; tail -2 "$TMUX_LOG" | sed 's/^/  尾 /'
  else echo "  日志不存在（tmux 缺失或没跑过）"; fi
  if command -v tmux >/dev/null 2>&1; then
    echo "  tmux 会话：$(tmux list-sessions 2>&1)"
    echo "  attach 抓屏（交互态能否恢复）："
    tmux capture-pane -t ccprobe -p 2>&1 | tail -3 | sed 's/^/    /'
  else
    echo "  tmux 缺失，跳过会话检查"
  fi

  echo
  echo "--- [B] setsid 日志 ---"
  if [ -f "$SETSID_LOG" ]; then
    echo "  共 $(wc -l < "$SETSID_LOG") 行"; head -1 "$SETSID_LOG" | sed 's/^/  首 /'; tail -2 "$SETSID_LOG" | sed 's/^/  尾 /'
    if command -v pgrep >/dev/null 2>&1; then
      echo "  进程还在吗：$(pgrep -f 'seq 1 60' | tr '\n' ' ')"
    else
      echo "  pgrep 缺失，跳过进程检查"
    fi
  else echo "  日志不存在（setsid 缺失或没跑过）"; fi

  echo
  echo "--- [C] claude ---"
  if [ -f /tmp/ccprobe-claude.log ]; then
    echo "  内容："; sed 's/^/    /' /tmp/ccprobe-claude.log
  else
    echo "  没跑过（远端无 claude）或还没开始"
  fi
}

case "$PHASE" in
  1) phase1 ;;
  2) phase2 ;;
  *) echo "用法：$0 1|2" ;;
esac
