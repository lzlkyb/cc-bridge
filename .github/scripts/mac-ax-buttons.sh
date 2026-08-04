#!/usr/bin/env bash
# 列出当前窗口内所有可交互元素的可访问名称（比 mac-ax-probe.sh 轻，用于交互后复查）。
# 用法：mac-ax-buttons.sh <unix_pid> [标题]
set +e
PID="$1"
TITLE="${2:-当前窗口可交互元素}"
if [ -z "$PID" ]; then
  echo "usage: mac-ax-buttons.sh <unix_pid> [title]"
  exit 2
fi

echo "::group::$TITLE"
osascript <<APPLESCRIPT 2>&1
with timeout of 90 seconds
  tell application "System Events" to tell (first process whose unix id is $PID)
    set out to {}
    try
      set els to entire contents of window 1
    on error errm
      return "FAIL: " & errm
    end try
    set end of out to "元素总数=" & (count of els)
    set n to 0
    repeat with e in els
      try
        set r to role of e
        if r is in {"AXButton", "AXLink", "AXTextField", "AXCheckBox", "AXStaticText"} then
          if n < 90 then
            set nm to ""
            try
              set nm to (name of e) as string
            end try
            -- 无名元素对定位没用，跳过以免满屏
            if nm is not "" and nm is not "missing value" then
              set end of out to r & " | " & nm
              set n to n + 1
            end if
          end if
        end if
      end try
    end repeat
    set AppleScript's text item delimiters to linefeed
    return out as string
  end tell
end timeout
APPLESCRIPT
echo "::endgroup::"
