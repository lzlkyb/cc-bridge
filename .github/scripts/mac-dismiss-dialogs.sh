#!/usr/bin/env bash
# 点掉当前屏幕上的系统授权模态框（主要是 macOS 的屏幕录制 TCC 授权框）。
#
# 为何需要：CI 里第一次 screencapture 会弹出「xxx is requesting to bypass the system
# private window picker...」模态框。它抢键盘焦点，会把后续发给被测应用的按键
# （Cmd+W / Cmd+Q）全部吃掉，并遮住截图。不先清掉它，GUI 验证结果全是假的。
#
# 做法：遍历所有进程的窗口，找到带「Allow / 允许 / OK / 好」按钮的就点。
# 故意不限定进程名：这类框属于哪个系统进程（UserNotificationCenter /
# ScreenCaptureApprovalUI / …）随版本变，按按钮文本找更稳。
set +e

osascript <<'APPLESCRIPT'
set clicked to {}
tell application "System Events"
  repeat with p in every process
    try
      repeat with w in windows of p
        try
          repeat with b in buttons of w
            set bn to name of b
            if bn is in {"Allow", "允许", "OK", "好", "Continue", "继续"} then
              click b
              set end of clicked to (name of p) & " -> " & bn
            end if
          end repeat
        end try
      end repeat
    end try
  end repeat
end tell
if clicked is {} then
  return "no dialog found"
else
  return "clicked: " & (clicked as string)
end if
APPLESCRIPT

echo "dismiss exit=$?"
