#!/usr/bin/env bash
# 探针：辅助功能（AX）能不能看到 **webview 内部** 的元素。
#
# 为何要探这个：之前查 `name of every button of window 1` 返回为空，我据此说“webview
# 内容对 AX 是一整块、点不到”——但那只能证明**窗口级**（标题栏）没有按钮。
# macOS 上 WKWebView 实际会暴露完整的网页 AX 树（VoiceOver 能读网页就靠它），
# 元素在更深的层级（window → group… → AXWebArea → …）。
#
# 这个结论很关键，一次回答两件事：
#   1. 能否点应用内的「立即更新」按钮 → 决定自动更新能不能在 CI 里真跑；
#   2. 能否点自绘标题栏的关闭按钮 → 决定清单 N15/N8 的关窗验证能不能自动化。
#
# 用法：mac-ax-probe.sh <unix_pid>
set +e
PID="$1"
if [ -z "$PID" ]; then
  echo "usage: mac-ax-probe.sh <unix_pid>"
  exit 2
fi

# 分层探，而不是一上来就 entire contents：后者对复杂页面可能很慢甚至超时，
# 而且一旦报错就什么信息都拿不到。先拿便宜的结构信息。
echo "::group::AX 第一层：window 1 的直接子元素"
osascript <<APPLESCRIPT 2>&1
with timeout of 30 seconds
  tell application "System Events" to tell (first process whose unix id is $PID)
    set w to window 1
    return "window role=" & (role of w) & " | children roles=" & ((role of every UI element of w) as string)
  end tell
end timeout
APPLESCRIPT
echo "::endgroup::"

echo "::group::AX 全树：统计 + 可交互元素清单（最多 80 条）"
osascript <<APPLESCRIPT 2>&1
with timeout of 120 seconds
  tell application "System Events" to tell (first process whose unix id is $PID)
    set out to {}
    try
      set els to entire contents of window 1
    on error errm
      return "entire contents 失败（说明 AX 穿不进去）：" & errm
    end try
    set end of out to "元素总数=" & (count of els)
    set n to 0
    set webAreas to 0
    repeat with e in els
      try
        set r to role of e
        if r is "AXWebArea" then set webAreas to webAreas + 1
        -- 只列可交互的与文本，否则 group/分隔符会满屏
        if r is in {"AXButton", "AXWebArea", "AXLink", "AXTextField", "AXCheckBox"} then
          if n < 80 then
            set nm to ""
            try
              set nm to (name of e) as string
            end try
            set dsc to ""
            try
              set dsc to (description of e) as string
            end try
            set end of out to r & " | name=" & nm & " | desc=" & dsc
            set n to n + 1
          end if
        end if
      end try
    end repeat
    set end of out to "AXWebArea 个数=" & webAreas & "（>0 就意味着 AX 穿进了 webview）"
    set AppleScript's text item delimiters to linefeed
    return out as string
  end tell
end timeout
APPLESCRIPT
echo "::endgroup::"

# 应用自绘标题栏的关闭按钮：先看能不能按 name/description 定位到它。
# 前端给这类按钮的可访问名称可能是中文（关闭）、英文（Close）或 aria-label，
# 所以上面那份清单才是重点——它能告诉我们真实的名字叫什么。
echo "probe done"
