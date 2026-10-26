#!/bin/bash
# 批 3-2 / S2 装配验证（2026-10-26）
#
# 验什么：Rust 侧 `hosted_bootstrap_script` **真实产出的那份装配脚本** + 真 claude，
#         NDJSON 能不能双向通。
#
# 与 `3-2托管探针-2026-10-25.sh` 的分工：
#   探针   —— 假 worker（心跳脚本），验「本地断开后进程不死」这个**原理**；
#   本脚本 —— 换成真 claude，验「我们代码生成的那份脚本」跑得起来，且
#             stdin 的 NDJSON 进得去、stdout 的 stream-json 出得来。
#
# 用法（远端 Linux）：
#   ssh <host> 'bash -s'       < tools/3-2-S2装配验证-2026-10-26.sh   # 跑（会调一次模型）
#   ssh <host> 'bash -s tail'  < tools/3-2-S2装配验证-2026-10-26.sh   # 再看一眼日志
#   ssh <host> 'bash -s clean' < tools/3-2-S2装配验证-2026-10-26.sh   # 收尾
#
# ⚠️ run 阶段真的会调用一次模型（只让它回一句 S2-OK），消耗远端额度。
#
# 判据：
#   [1] tmux 会话起来了
#   [2] 日志里有 stream-json（说明 claude 的 stdout 真的接到了 $B.out）
#   [3] 日志里有 type=result 且 is_error 不是 true（说明写进 FIFO 的那句话被处理了）

PHASE="${1:-run}"
D="$HOME/.cc-bridge/hosted"
KEYFILE="$D/s2-last-key"

section() { printf '\n=== %s ===\n' "$1"; }

phase_run() {
  section "环境"
  local missing=0 c
  for c in tmux mkfifo timeout; do
    if command -v "$c" >/dev/null 2>&1; then echo "  $c: $(command -v "$c")"; else echo "  $c: 缺失"; missing=1; fi
  done
  local CLAUDE
  CLAUDE="$(command -v claude 2>/dev/null)"
  if [ -n "$CLAUDE" ]; then echo "  claude: $CLAUDE"; else echo "  claude: 缺失"; missing=1; fi
  if [ "$missing" != 0 ]; then echo; echo "缺依赖，中止（不消耗额度）"; exit 1; fi

  local K="cc-s2-$(date +%s)"
  local FIFO="$D/$K.in" LOG="$D/$K.out" W="$D/$K.sh"
  mkdir -p "$D"
  printf '%s\n' "$K" > "$KEYFILE"

  # ---------------------------------------------------------------
  # 下面这段与 `hosted_bootstrap_script` 的产出逐字对齐：
  #   exec 9<> 读写双开（写端关闭时读端拿不到 EOF）、cd 在 exec 之前、
  #   claude 那行带 exec（shell 被替换、信号直达）。
  # 唯一不同的是 claude 路径与参数用真值（不带 --resume：首轮）。
  # ---------------------------------------------------------------
  section "装配（对齐 hosted_bootstrap_script 的产出）"
  tmux kill-session -t "$K" 2>/dev/null || true
  rm -f "$FIFO" "$LOG"
  mkfifo -m 600 "$FIFO"
  : > "$LOG"
  cat > "$W" <<SH
#!/bin/bash
B="\${0%.sh}"
exec 9<>"\$B.in"
exec <&9
cd "\$HOME" || exit 97
exec $(printf '%q' "$CLAUDE") '--print' '--input-format' 'stream-json' '--output-format' 'stream-json' '--verbose' '--include-partial-messages' '--permission-prompt-tool' 'stdio' '--permission-mode' 'default' >>"\$B.out" 2>&1
SH
  chmod +x "$W"
  tmux new-session -d -s "$K" "bash '$W'"
  printf '__LOG__%s\n' "$LOG"

  # worker 里 bash 起来 + claude 就绪要一点时间。write 侧本身有 10s 超时兜底，
  # 这里先给 2s 是让「claude 已在读」这件事大概率成立，避免无谓地撞超时。
  sleep 2

  section "写一行 user message 进 FIFO"
  # 与 `session.rs::user_message_line` 生成的形状一致。
  local MSG='{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: S2-OK"}]}}'
  printf '%s\n' "$MSG" | timeout 10 bash -c 'cat > "$1"' _ "$FIFO"
  echo "  写入退出码：$?"

  section "等 claude 输出（最多 90s）"
  local i
  for i in $(seq 1 90); do
    if grep -qE '"type": ?"result"' "$LOG" 2>/dev/null; then
      echo "  第 ${i}s 收到 result"
      break
    fi
    sleep 1
  done

  judge "$K" "$LOG"
}

judge() {
  local K="$1" LOG="$2" ok=1 n
  section "判据"
  if tmux has-session -t "$K" 2>/dev/null; then
    echo "  [1] tmux 会话在 ✓"
  else
    echo "  [1] tmux 会话没了 ✗"
    ok=0
  fi

  n=$(grep -cE '^\{' "$LOG" 2>/dev/null || true)
  n=${n:-0}
  if [ "$n" -gt 0 ] 2>/dev/null; then
    echo "  [2] 日志里有 $n 行 JSON ✓"
  else
    echo "  [2] 日志里没有 JSON ✗（claude 的 stdout 没接到 \$B.out，或它压根没起来）"
    ok=0
  fi

  if grep -qE '"type": ?"result"' "$LOG" 2>/dev/null; then
    if grep -qE '"is_error": ?true' "$LOG" 2>/dev/null; then
      echo "  [3] 有 result 但 is_error=true ✗（装配是通的，问题在模型/凭据侧）"
      ok=0
    else
      echo "  [3] 有 result 且非 error ✓"
    fi
  else
    echo "  [3] 没有 result ✗"
    ok=0
  fi

  section "日志尾部（最多 20 行）"
  tail -20 "$LOG" 2>/dev/null || echo "  （空）"

  section "结论"
  if [ "$ok" = 1 ]; then
    echo "  S2 通过：装配脚本 + 真 claude，NDJSON 双向通"
    echo "  会话名：$K —— 收尾跑：ssh <host> 'bash -s clean' < tools/3-2-S2装配验证-2026-10-26.sh"
  else
    echo "  S2 未通过。先看两处："
    echo "    · 日志里是「认证/额度」类错误 ⇒ 环境问题，装配本身可能已经通了"
    echo "    · 日志完全空 / claude 立刻退出 ⇒ 装配问题，把上面全部输出贴回来"
  fi
}

phase_tail() {
  local K LOG
  K="$(cat "$KEYFILE" 2>/dev/null)"
  if [ -z "$K" ]; then echo "没有上次的会话记录（$KEYFILE），先跑 run"; exit 1; fi
  LOG="$D/$K.out"
  echo "会话：$K"
  echo "日志：$LOG"
  echo
  tail -30 "$LOG" 2>/dev/null || echo "（日志不存在）"
  echo
  if tmux has-session -t "$K" 2>/dev/null; then echo "tmux：还活着"; else echo "tmux：已结束"; fi
}

phase_clean() {
  local K
  K="$(cat "$KEYFILE" 2>/dev/null)"
  if [ -z "$K" ]; then echo "没有可清理的会话"; exit 0; fi
  tmux kill-session -t "$K" 2>/dev/null || true
  rm -f "$D/$K.in" "$D/$K.out" "$D/$K.sh" "$KEYFILE"
  echo "已清理：$K"
}

case "$PHASE" in
  run) phase_run ;;
  tail) phase_tail ;;
  clean) phase_clean ;;
  *) echo "未知阶段：$PHASE（可用：run / tail / clean）"; exit 2 ;;
esac
