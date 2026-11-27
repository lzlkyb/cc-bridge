use std::{io::Write, os::windows::ffi::OsStrExt, path::Path};
use windows::{
    core::{w, PCWSTR},
    Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};

const INSTALLER_PREFIX: &str = "ccbridge-update-";

pub(super) fn clean_installers(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(INSTALLER_PREFIX) && name.ends_with(".exe"))
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub(super) fn launch_nsis(data_dir: &Path, bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"MZ") {
        return Err("安装包不是 Windows 安装程序，请重新下载".into());
    }
    clean_installers(data_dir);
    let mut file = tempfile::Builder::new()
        .prefix(INSTALLER_PREFIX)
        .suffix(".exe")
        .tempfile_in(data_dir)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    let (file, path) = file.keep().map_err(|error| error.to_string())?;
    drop(file);
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let args: Vec<u16> = format!("/P /UPDATE /R /CCBUPDATEPID={}", std::process::id())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // Only the already verified NSIS package is run. Leave the current window and tray intact
    // while Windows asks for consent or rejects the launch, so the user can retry.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR(args.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if (result.0 as isize) <= 32 {
        let _ = std::fs::remove_file(path);
        return Err(format!(
            "Windows 安装程序未启动（{}），可重试或手动下载",
            result.0 as isize
        ));
    }
    Ok(())
}
