use super::VolumeUsage;
use std::path::Path;

#[cfg(windows)]
pub(crate) fn measure_volume(path: &Path) -> Option<VolumeUsage> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetVolumePathNameW},
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0;
    let mut total = 0;
    let mut root = [0u16; 1024];
    // Both calls borrow a NUL-terminated path and initialized storage for the outputs.
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free),
            Some(&mut total),
            None,
        )
    }
    .ok()?;
    let label = unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), &mut root) }
        .ok()
        .and_then(|()| String::from_utf16(root.split(|&c| c == 0).next()?).ok())
        .map(|root| root.trim_end_matches('\\').to_string())
        .filter(|root| !root.is_empty())
        .unwrap_or_else(|| "应用数据磁盘".into());
    Some(VolumeUsage {
        label,
        free_bytes: free,
        total_bytes: total,
    })
}

#[cfg(unix)]
pub(crate) fn measure_volume(path: &Path) -> Option<VolumeUsage> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = MaybeUninit::<libc::statvfs>::uninit();
    // statvfs initializes the output only on success.
    let stat = unsafe {
        if libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) != 0 {
            return None;
        }
        stat.assume_init()
    };
    Some(VolumeUsage {
        label: "应用数据磁盘".into(),
        free_bytes: (stat.f_bavail as u128 * stat.f_frsize as u128).min(u64::MAX as u128) as u64,
        total_bytes: (stat.f_blocks as u128 * stat.f_frsize as u128).min(u64::MAX as u128) as u64,
    })
}
