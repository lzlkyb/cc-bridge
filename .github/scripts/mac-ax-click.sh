#!/usr/bin/env bash
# 按可访问名称点击 **webview 内** 的按钮。
#
# 为何能这么做：之前我判定「webview 内容对 AX 是一整块、点不到」，实测推翻了——
# mac-ax-probe.sh 在真实 macOS 上拿到 AXWebArea 与 136 个元素，连按钮的中文名都能读到
# （关闭窗口 / 停止服务 / 跳过引导 / …）。所以应用内的按钮是可以自动点的。
#
# 注意用 entire contents 而不是 `button ... of window 1`：后者只查**直接子元素**，
# 而 webview 里的按钮在很深的层级（window → AXGroup → … → AXWebArea → …）。
#
# 用法：mac-ax-click.sh <unix_pid> <按钮可访问名称>
set +e
PID="$1"
NAME="$2"
if [ -z "$PID" ] || [ -z "$NAME" ]; then
  echo "usage: mac-ax-click.sh <unix_pid> <button-name>"
  exit 2
fi

osascript <<APPLESCRIPT 2>&1
with timeout of 90 seconds
  tell application "System Events" to tell (first process whose unix id is $PID)
    try
      set els to entire contents of window 1
    on error errm
      return "FAIL 拿不到 window 1 的元素：" & errm
    end try
    repeat with e in els
      try
        if (role of e is "AXButton") and (((name of e) as string) is "$NAME") then
          click e
          return "OK clicked: $NAME"
        end if
      end try
    end repeat
    return "NOTFOUND: $NAME"
  end tell
end timeout
APPLESCRIPT
