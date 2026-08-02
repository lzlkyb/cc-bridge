; cc-bridge NSIS 安装器钩子：安装时自动配置 Windows 防火墙入站规则，卸载时清理。
;
; 为何放在安装器：写防火墙规则需要管理员权限。若安装器本身已提权（perMachine
; 安装，或用户以管理员运行安装包），这里就能一次性配好，用户无需任何操作。
;
; 重要前提：Tauri 默认的 NSIS installMode 是 currentUser（不提权），此时下面的 netsh
; 会因权限不足失败。这是可接受的：失败不会中止安装，用户首次启动后会在「连接」
; 页看到防火墙告警块，点一下「一键修复」（单次 UAC）即可。不为了这个改 installMode，
; 因为 perMachine 会让自动更新的静默安装也需要提权，得不偿失。
;
; 规则写法与应用内「一键修复」保持一致（见 firewall_diag.rs 的 build_repair_script）：
; - profile=any：一条规则同时覆盖 域/专用/公用。省略它实测只会落到 Public，
;   当前网络是域或专用时规则完全不生效——这就是「必须关防火墙才能用」的根因。
; - 先 delete 再 add：幂等，重装 / 升级不会堆积重复规则。
; - 默认端口 7823；用户在应用内改端口后，由应用自己重建带新端口的规则。

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "配置 Windows 防火墙入站规则 (7823/TCP)..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="cc-bridge" dir=in'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="cc-bridge (7823/TCP)" dir=in'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="cc-bridge (7823/TCP)" dir=in action=allow protocol=TCP localport=7823 profile=any enable=yes program="$INSTDIR\cc-bridge.exe"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "防火墙规则已写入。"
  ${Else}
    DetailPrint "写入防火墙规则未成功（通常是安装器未提权）。首次启动后在「连接」页点「一键修复」即可。"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "清理 Windows 防火墙入站规则..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="cc-bridge (7823/TCP)" dir=in'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="cc-bridge" dir=in'
  Pop $0
!macroend
