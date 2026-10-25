#!/bin/bash
# 3-2 托管探针（2026-10-25）：验证「tmux + FIFO + 日志」能否同时满足
#   ① claude 与我们的 NDJSON 双向管道（不是 TUI 的终端流）；
#   ② 本地（ssh）断开后进程不收到 EOF、继续跑；
#   ③ 重连后还能继续往同一会话写、从同一份日志读。
#
# 0-4 只验到「tmux 能让进程跨断线活着」与「TUI 能 attach 恢复」。本探针验的是
# **我们要用的那条通道** —— NDJSON over FIFO + log，TUI 完全不参与。
#
# 用法（远端 Linux；本地经 ssh stdin 直送，不落盘）：
#   第一段  ssh <host> 'bash -s 1' < tools/3-2托管探针-2026-10-25.sh
#   然后把 ssh 彻底断开（关窗口 / kill），等 20s 以上
#   第二段  ssh <host> 'bash -s 2' < tools/3-2托管探针-2026-10-25.sh
#   收尾    ssh <host> 'bash -s clean' < tools/3-2托管探针-2026-10-25.sh
#
# 判据（第二段逐条对照）：
#   [1] tmux 会话还在（tmux has-session 返回 0）
#   [2] 心跳在断线期间持续增长
#   [3] 第二段写进 FIFO 的行出现在日志里（重连后双向仍通）
#   [4] 进程还在（没有因为写端关闭拿到 EOF 而退出）

PHASE="${1:-1}"
DIR="$HOME/.cc-bridge/probe32"
FIFO="$DIR/in.fifo"
LOG="$DIR/out.log"
WORKER="$DIR/worker.sh"
SESS="cc-probe32"

section() { printf '\n=== %s ===\n' "$1"; }
# 写 FIFO 必须带超时：没有读者时 `> fifo` 会永久阻塞，探针会挂死在那儿。
# 🔴 `$1` 是**要送进 FIFO 的文件**（FIFO 路径已固定在 `$FIFO`）。
#    2026-10-25 首跑踩过：这里写成 `$2` 而调用只传一个参数 ⇒ 重定向目标为空，
#    报 `: No such file or directory`，看着像「FIFO 写不进去」，其实是脚本自己错了。
say() { timeout 5 bash -c 'cat > "$1"' _ "$FIFO" < "$1" && return 0 || return 1; }

phase1() {
  section "环境"
  for c in tmux mkfifo timeout; do
    if command -v "$c" >/dev/null 2>&1; then echo "  $c: $(command -v $c)"; else echo "  $c: 缺失 ← 本探针无法进行"; fi
  done
  tmux -V 2>&1 | sed 's/^/  /'

  section "准备 FIFO + 日志 + 假 claude"
  mkdir -p "$DIR"
  tmux kill-session -t "$SESS" 2>/dev/null
  rm -f "$FIFO" "$LOG"
  mkfifo -m 600 "$FIFO" || { echo "  mkfifo 失败，中止"; exit 1; }
  : > "$LOG"

  # 「假 claude」：从 FIFO 读 NDJSON 行、把行原样回显进日志；同时每 5s 打一条心跳。
  # 🔴 支点在第一行：`exec 9<>"$FIFO"` 让同一个 fd 既是读端又是写端 ⇒
  #    本地写端关闭时读端**拿不到 EOF**（总有「自己」这个写者），进程不会自杀。
  #    去掉 `<>`（改用 `<`）时，这个探针会看到「断线后进程退出」—— 那正是要证明的事。
  cat > "$WORKER" <<'WORKER_EOF'
#!/bin/bash
FIFO="$1"; LOG="$2"
exec 9<>"$FIFO"
( while IFS= read -r line <&9; do printf '{"echo":%s}\n' "$line" >> "$LOG"; done ) &
while :; do echo "beat $(date +%s)" >> "$LOG"; sleep 5; done
WORKER_EOF
  chmod +x "$WORKER"

  tmux new-session -d -s "$SESS" "bash '$WORKER' '$FIFO' '$LOG'"
  sleep 2
  echo "  会话：$(tmux list-sessions 2>/dev/null | grep "$SESS" || echo '没起来')"
  echo "  日志开头："; head -2 "$LOG" 2>/dev/null | sed 's/^/    /'

  section "本地写一行进 FIFO（模拟发一句用户消息）"
  # 真实实现里这一步是 `ssh host 'cat > fifo'` 的 stdin；这里就地写。
  printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"探针第一句"}]}}\n' > "$DIR/p1.txt"
  if say "$DIR/p1.txt"; then
    sleep 2
    echo "  写入成功，日志尾部："; tail -3 "$LOG" 2>/dev/null | sed 's/^/    /'
  else
    echo "  ❌ 写不进 FIFO"
  fi
  echo
  echo "  断线前日志行数：$(wc -l < "$LOG")"
  echo "  🔴 现在必须**真的断开 SSH**（关窗口 / kill ssh），等 20s 以上，"
  echo "     再跑第二段：ssh <host> 'bash -s 2' < tools/3-2托管探针-2026-10-25.sh"
}

phase2() {
  section "[1] tmux 会话是否还活着"
  if tmux has-session -t "$SESS" 2>/dev/null; then
    echo "  ✅ 会话仍在：$SESS"
    tmux list-panes -t "$SESS" -F '  pane pid=#{pane_pid} cmd=#{pane_current_command}' 2>/dev/null
  else
    echo "  ❌ 会话没了（进程在断线时退出）"
  fi

  section "[2] 断线期间心跳有没有继续"
  local beats total first last
  beats=$(grep -c '^beat ' "$LOG" 2>/dev/null || true)
  total=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  first=$(grep '^beat ' "$LOG" 2>/dev/null | head -1 | awk '{print $2}')
  last=$(grep '^beat ' "$LOG" 2>/dev/null | tail -1 | awk '{print $2}')
  echo "  当前日志 $total 行，其中心跳 ${beats:-0} 条"
  if [ -n "$first" ] && [ -n "$last" ] && [ "$last" -gt "$first" ]; then
    echo "  ✅ 心跳 $first → $last（跨了 $((last - first)) 秒，说明断线期间仍在跑）"
  else
    echo "  ❌ 心跳没有增长"
  fi

  section "[3] 重连后双向通道是否仍通"
  printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"探针第二句"}]}}\n' > "$DIR/p2.txt"
  if say "$DIR/p2.txt"; then echo "  写入 FIFO 成功"; else echo "  ❌ 写不进去（FIFO 没了 / 没有读者）"; fi
  sleep 2
  if grep -q '探针第二句' "$LOG" 2>/dev/null; then
    echo "  ✅ 第二句已出现在日志里（写端 → 进程 → 日志 全通）"
  else
    echo "  ❌ 日志里没有第二句"
  fi
  echo "  日志尾部："; tail -3 "$LOG" 2>/dev/null | sed 's/^/    /'

  section "[4] 进程是否存在（没有因为 EOF 退出）"
  local pid
  pid=$(tmux list-panes -t "$SESS" -F '#{pane_pid}' 2>/dev/null | head -1)
  if [ -n "$pid" ]; then
    echo "  ✅ pane pid=$pid"
    ps -o pid,ppid,sid,etime,cmd -p "$pid" 2>/dev/null | sed 's/^/    /'
  else
    echo "  （会话已不在，见 [1]）"
  fi

  section "结论模板（照实填，别猜）"
  cat <<'TXT'
  [1] tmux 会话存活        ：通过 / 失败
  [2] 断线期间心跳增长      ：通过 / 失败（间隔 __ 秒，增长 __ 条）
  [3] 重连后双向通道        ：通过 / 失败
  [4] 进程未被 EOF 杀掉     ：通过 / 失败
  ⇒ 全通过才可开工「托管会话」（docs/批3-2会话不死方案-2026-10-25.md §四）。
TXT
}

phase_clean() {
  section "清理"
  tmux kill-session -t "$SESS" 2>/dev/null && echo "  已杀会话 $SESS" || echo "  会话本就不在"
  rm -rf "$DIR" && echo "  已删 $DIR"
}

case "$PHASE" in
  1) phase1 ;;
  2) phase2 ;;
  clean) phase_clean ;;
  *) echo "用法：bash $0 1|2|clean"; exit 2 ;;
esac
