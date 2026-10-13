//! 系统集成类 IPC 命令：开机自启、安装位置、桌面快捷方式。
//!
//! D19 方案 C 第 4 批。这一组的特点是**几乎全是平台专属实现**：
//! `create_desktop_shortcut_impl` 有 Windows / 非 Windows 两个版本，
//! 而 `resolve_install_dir` 在 mac 上要往上三层取 `.app` 本体（否则展示的是包内路径）。
//! 搬动这类代码最容易漏掉其中一个 cfg 分支——第 2 批就因此报过 E0599。
//!
//! 本文件是**纯搬动**：函数体逐字节未改。

// `create_desktop_shortcut_impl` 的 Windows 版要用 `Command::creation_flags`
// （CREATE_NO_WINDOW，避免弹出 powershell 黑框）。必须跟着调用点一起 cfg 门控：
// mac 上这个 trait 不存在，不门控则 `--no-default-features` 的 mac clippy 直接报错。
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// 安装位置：Windows 上就是 exe 所在目录；macOS 上要**从 .app 包内部走出来**。
///
/// mac 的 `current_exe()` 落在 `…/cc-bridge.app/Contents/MacOS/cc-bridge-desktop`，
/// 直接取 parent 得到的是 `Contents/MacOS`——展示给用户是一串包内部路径，
/// 再交给 reveal_item_in_dir 更是直接把访达跳进「显示包内容」。
/// 所以往上三层找 `.app` 本体：MacOS → Contents → *.app。
/// 任一层不符（开发模式下 target/debug 里的裸二进制）就按原样返回 parent。
fn resolve_install_dir() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位自身路径: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "无法解析安装目录".to_string())?;
    #[cfg(target_os = "macos")]
    if let Some(bundle) = dir.parent().and_then(|contents| contents.parent()) {
        if bundle.extension().is_some_and(|ext| ext == "app") {
            return Ok(bundle.to_string_lossy().into_owned());
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// 返回软件安装位置，用于前端「安装位置」展示。
/// 发布版：Windows 是安装目录、macOS 是 `.app` 本体；开发模式指向 target/debug。
#[tauri::command]
pub fn install_dir() -> Result<String, String> {
    resolve_install_dir()
}

/// 在系统文件管理器中打开（定位）安装位置。
/// 使用 tauri-plugin-opener 的 reveal_item_in_dir（Windows 底层 SHOpenFolderAndSelectItems，
/// macOS 走 NSWorkspace 在访达里选中目标），不产生子进程、不闪 cmd 窗口；
/// 项目已依赖并注册 opener 插件（Cargo.toml:18 / main.rs:137）。
/// 同时返回该路径字符串，便于前端展示。
#[tauri::command]
pub fn reveal_install_dir() -> Result<String, String> {
    let dir = resolve_install_dir()?;
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|e| format!("打开安装目录失败: {e}"))?;
    Ok(dir)
}

/// 在桌面创建（或覆盖）指向本程序的快捷方式。**仅 Windows**，见下方两份 impl。
#[tauri::command]
pub fn create_desktop_shortcut(app: tauri::AppHandle) -> Result<(), String> {
    create_desktop_shortcut_impl(app)
}

/// 非 Windows 没有 .lnk 这回事：macOS 上应用装在 /Applications、入口是 Dock 与启动台，
/// 桌面本来就不放图标。前端已按平台隐藏这一行（SettingsTab.tsx 的 InstallGroup），
/// 这里再兜一层明确报错——否则会一路走到 Windows 版里去 spawn `powershell`，
/// mac 上拿到的是「No such file or directory」这种看不出所以然的底层错误。
#[cfg(not(windows))]
fn create_desktop_shortcut_impl(_app: tauri::AppHandle) -> Result<(), String> {
    Err("桌面快捷方式仅 Windows 支持；macOS 请把 cc-bridge.app 拖到 Dock 或从启动台打开".into())
}

/// 复用系统 WScript.Shell COM（零 Rust 依赖，守规则8），普通用户权限即可，
/// 桌面为当前用户可写目录，无需 UAC 提权。用户确认：已存在同名 lnk 直接覆盖。
/// 桌面路径优先取 USERPROFILE\Desktop，失败回退 Tauri desktop_dir()。
#[cfg(windows)]
fn create_desktop_shortcut_impl(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager; // app.path()；仅此处需要，见文件顶部 use 行的注释
    let exe = std::env::current_exe().map_err(|e| format!("无法定位自身路径: {e}"))?;
    let exe_str = exe.to_string_lossy().into_owned();
    let dir_str = exe
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();

    // 桌面路径：优先 USERPROFILE\Desktop（不依赖 Tauri path 插件，最稳）；
    // 失败则回退到 Tauri 的 desktop_dir() 解析。
    let desktop = std::env::var("USERPROFILE")
        .map(|u| std::path::Path::new(&u).join("Desktop"))
        .or_else(|_| {
            app.path()
                .desktop_dir()
                .map(|p| p.to_path_buf())
                .map_err(|e| format!("无法解析桌面目录: {e}"))
        })
        .map_err(|e| e.to_string())?;
    let lnk_path = desktop.join("cc-bridge.lnk");
    let lnk_str = lnk_path.to_string_lossy().into_owned();

    // 单引号 PowerShell 字符串：路径中的单引号转义为两个单引号（反斜杠在单引号中即字面量）。
    let ps = format!(
        "$ws=New-Object -ComObject WScript.Shell; \
         $lnk=$ws.CreateShortcut('{lnk}'); \
         $lnk.TargetPath='{exe}'; \
         $lnk.IconLocation='{exe},0'; \
         $lnk.Description='cc-bridge'; \
         $lnk.WorkingDirectory='{dir}'; \
         $lnk.Save()",
        lnk = lnk_str.replace('\'', "''"),
        exe = exe_str.replace('\'', "''"),
        dir = dir_str.replace('\'', "''"),
    );
    let mut cmd = std::process::Command::new("powershell");
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：隐藏 powershell 控制台窗口，避免闪黑框
    let out = cmd
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps,
        ])
        .output()
        .map_err(|e| format!("创建快捷方式失败: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "创建桌面快捷方式失败".into()
        } else {
            format!("创建桌面快捷方式失败：{msg}")
        });
    }
    Ok(())
}

/// 剪贴板图片中转文件：把前端编码好的 PNG 字节写进系统临时目录，返回完整路径。
///
/// WHY 存在：剪贴板图片上传走 `ssh_sftp_put`（scp 只认**本机路径**），而剪贴板里
/// 只有字节没有路径——必须有落盘一步。为什么不引 `plugin-fs`：与 `local_path_info`
/// 同一个判断，为写一个临时文件把整块文件系统权限面开给前端，代价远大于收益。
///
/// 文件名带 `cc-bridge-clip-` 前缀 + 纳秒时间戳，碰撞即覆盖也无害（同一意图）。
/// 清理是双保险：上传成功后前端调 `temp_file_remove`，漏删的交给系统临时目录回收。
///
/// 仅本机面板经 Tauri IPC 调用，不注册为 MCP 工具（不给远端任何本机文件系统入口）。
#[tauri::command]
pub async fn temp_file_write(data: Vec<u8>, ext: String) -> Result<String, String> {
    if data.is_empty() {
        return Err("内容为空，拒绝写入".into());
    }
    // 扩展名白名单：只放行 ASCII 字母数字，防路径穿越与文件名注入。
    if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("非法扩展名：{ext}"));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("cc-bridge-clip-{nanos}.{ext}"));
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, &data).map_err(|e| format!("写临时文件失败：{e}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("写临时文件任务异常终止：{e}"))?
}

/// 删除 `temp_file_write` 落下的中转文件。
///
/// 双保险守卫：路径必须在系统临时目录内（canonicalize 后比较，符号链接绕不过）、
/// 文件名必须以我们的前缀开头——两条件缺一拒绝。删除失败（文件已不在）不报错，
/// 幂等：调用方只是收尾，不值得为它弹一次错误提示。
#[tauri::command]
pub async fn temp_file_remove(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);
        // 文件已不存在 → canonicalize 必然失败。「删一个已经不在的文件」按文档
        // 幂等成功返回，不能拿失败回退的原始路径去比前缀（Windows 下 canonicalize
        // 结果带 \\?\ 前缀，回退路径没有，必然失配误报「不在临时目录内」）。
        let canon = match p.canonicalize() {
            Ok(c) => c,
            Err(_) => return Ok(()),
        };
        let tmp = std::env::temp_dir();
        let tmp_canon = tmp.canonicalize().unwrap_or(tmp);
        if !canon.starts_with(&tmp_canon) {
            return Err("拒绝删除：目标不在临时目录内".into());
        }
        let name_ok = canon
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("cc-bridge-clip-"))
            .unwrap_or(false);
        if !name_ok {
            return Err("拒绝删除：不是 cc-bridge 的临时文件".into());
        }
        let _ = std::fs::remove_file(&canon);
        Ok(())
    })
    .await
    .map_err(|e| format!("删除临时文件任务异常终止：{e}"))?
}
