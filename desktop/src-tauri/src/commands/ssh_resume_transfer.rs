use std::{
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, LazyLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dashmap::DashMap;
use russh_sftp::{
    client::{error::Error as SftpError, SftpSession},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use serde::Deserialize;
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt},
    sync::Mutex,
};

use super::ssh_cmds::{resolve_link_secrets, SshLink, TransferHooks};
use super::ssh_russh_cmds::get_russh_session;
use super::ssh_russh_file::{map_sftp_err, resolve_rename_target};
use crate::{ssh_proxy::PendingCreds, state::AppState};

type Signature = (u64, SystemTime);
type Checkpoints = DashMap<String, Arc<Mutex<Option<Checkpoint>>>>;
static PARTS: LazyLock<Checkpoints> = LazyLock::new(DashMap::new);

struct Checkpoint {
    link: SshLink,
    local: PathBuf,
    remote: String,
    upload: bool,
    temporary: String,
    prepared: bool,
    offset: u64,
    source: Signature,
    destination: Option<Signature>,
}

impl Drop for Checkpoint {
    fn drop(&mut self) {
        if !self.upload && self.prepared {
            let _ = std::fs::remove_file(&self.temporary);
        }
    }
}

async fn local_signature(path: &Path) -> Result<Option<Signature>, String> {
    match fs::symlink_metadata(path).await {
        Ok(info) if info.is_file() => {
            Ok(Some((info.len(), info.modified().map_err(map_sftp_err)?)))
        }
        Ok(_) => Err("不支持对此类型执行断点续传".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(map_sftp_err(error)),
    }
}

async fn remote_signature(
    sftp: &SftpSession,
    path: &str,
    no_follow: bool,
) -> Result<Option<Signature>, String> {
    let result = if no_follow {
        sftp.symlink_metadata(path).await
    } else {
        sftp.metadata(path).await
    };
    match result {
        Ok(info) if info.is_regular() => match (info.size, info.mtime) {
            (Some(size), Some(mtime)) => Ok(Some((
                size,
                UNIX_EPOCH + Duration::from_secs(u64::from(mtime)),
            ))),
            _ => Err("SFTP 服务器未提供续传所需的文件元数据".into()),
        },
        Ok(_) => Err("仅普通文件支持断点续传".into()),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(error) => Err(map_sftp_err(error)),
    }
}

fn cancelled(hooks: &TransferHooks) -> bool {
    hooks
        .cancel
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::Relaxed))
}

async fn copy_remainder<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    src: &mut R,
    dest: &mut W,
    offset: &mut u64,
    size: u64,
    hooks: &TransferHooks,
) -> Result<(), String> {
    let mut buf = vec![0u8; 64 * 1024];
    let progress = |done: u64| {
        (u128::from(done) * 100)
            .checked_div(u128::from(size))
            .unwrap_or(0)
            .min(99) as u8
    };
    let mut last = progress(*offset);
    hooks.emit_progress(last);
    while *offset < size {
        if cancelled(hooks) {
            return Err("CCB_CANCELLED".into());
        }
        let requested = (size - *offset).min(buf.len() as u64) as usize;
        let n = src
            .read(&mut buf[..requested])
            .await
            .map_err(map_sftp_err)?;
        if n == 0 {
            return Err("源文件提前结束，原目标文件未替换".into());
        }
        dest.write_all(&buf[..n]).await.map_err(map_sftp_err)?;
        *offset += n as u64;
        let percent = progress(*offset);
        if percent != last {
            hooks.emit_progress(percent);
            last = percent;
        }
    }
    dest.shutdown().await.map_err(map_sftp_err)
}

async fn upload_part(
    sftp: &SftpSession,
    part: &mut Checkpoint,
    hooks: &TransferHooks,
) -> Result<(), String> {
    let mut local = fs::File::open(&part.local).await.map_err(map_sftp_err)?;
    let flags = if part.prepared {
        let info = sftp
            .symlink_metadata(part.temporary.as_str())
            .await
            .map_err(map_sftp_err)?;
        if !info.is_regular() {
            return Err("远程续传临时文件已变化，请重新发起传输".into());
        }
        OpenFlags::WRITE
    } else {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE
    };
    let mut remote = sftp
        .open_with_flags(part.temporary.as_str(), flags)
        .await
        .map_err(map_sftp_err)?;
    part.prepared = true;
    if remote
        .metadata()
        .await
        .map_err(map_sftp_err)?
        .size
        .unwrap_or(0)
        < part.offset
    {
        return Err("远程续传临时文件已变化".into());
    }
    local
        .seek(SeekFrom::Start(part.offset))
        .await
        .map_err(map_sftp_err)?;
    remote
        .seek(SeekFrom::Start(part.offset))
        .await
        .map_err(map_sftp_err)?;
    copy_remainder(
        &mut local,
        &mut remote,
        &mut part.offset,
        part.source.0,
        hooks,
    )
    .await
}

async fn download_part(
    sftp: &SftpSession,
    part: &mut Checkpoint,
    hooks: &TransferHooks,
) -> Result<(), String> {
    if part.prepared
        && !matches!(
            local_signature(Path::new(&part.temporary)).await,
            Ok(Some(_))
        )
    {
        return Err("本机续传临时文件已变化，请重新发起传输".into());
    }
    let mut remote = sftp
        .open(part.remote.as_str())
        .await
        .map_err(map_sftp_err)?;
    let mut local = fs::OpenOptions::new()
        .write(true)
        .create_new(!part.prepared)
        .open(&part.temporary)
        .await
        .map_err(map_sftp_err)?;
    part.prepared = true;
    if local.metadata().await.map_err(map_sftp_err)?.len() < part.offset {
        return Err("本机续传临时文件已变化".into());
    }
    local.set_len(part.offset).await.map_err(map_sftp_err)?;
    local
        .seek(SeekFrom::Start(part.offset))
        .await
        .map_err(map_sftp_err)?;
    remote
        .seek(SeekFrom::Start(part.offset))
        .await
        .map_err(map_sftp_err)?;
    copy_remainder(
        &mut remote,
        &mut local,
        &mut part.offset,
        part.source.0,
        hooks,
    )
    .await
}

pub(super) struct ResumeRequest<'a> {
    pub local: &'a Path,
    pub remote: &'a str,
    pub upload: bool,
    pub overwrite: bool,
    pub comparison: Option<ComparedUpload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparedUpload {
    source: ComparedFile,
    destination: Option<ComparedFile>,
}

#[derive(Deserialize)]
struct ComparedFile {
    size: u64,
    mtime: u64,
}

impl ComparedUpload {
    fn validate(&self, source: Signature, destination: Option<Signature>) -> Result<(), String> {
        let matches = |planned: &ComparedFile, actual: Signature| {
            planned.size == actual.0
                && actual
                    .1
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|t| t.as_secs())
                    == Some(planned.mtime)
        };
        if matches(&self.source, source)
            && match (&self.destination, destination) {
                (Some(planned), Some(actual)) => matches(planned, actual),
                (None, None) => true,
                _ => false,
            }
        {
            return Ok(());
        }
        Err("文件已变化，请重新比较后再发起传输".into())
    }
}

pub(super) async fn discard(state: &AppState, id: &str) -> Result<(), String> {
    let Some(cell) = PARTS.get(id).map(|entry| entry.value().clone()) else {
        return Ok(());
    };
    let mut guard = cell.try_lock().map_err(|_| "任务正在运行，请稍后重试")?;
    if let Some(part) = guard.as_ref().filter(|part| part.upload && part.prepared) {
        let link = SshLink::from_config(&*state.config.read().await, &part.link.conn.id)?;
        if !part.link.same_login(&link) {
            return Err("服务器连接已修改，无法清理原服务器上的续传文件".into());
        }
        let creds = resolve_link_secrets(&link, &state.data_dir)?;
        let session = get_russh_session(state, &link, creds).await?;
        match session.sftp.remove_file(part.temporary.as_str()).await {
            Ok(()) => {}
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {}
            Err(error) => return Err(map_sftp_err(error)),
        }
    }
    *guard = None;
    PARTS.remove(id);
    Ok(())
}

pub(super) async fn transfer(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
    request: ResumeRequest<'_>,
    hooks: &TransferHooks,
) -> Result<(), String> {
    let id = hooks.transfer_id.as_ref().ok_or("缺少传输标识")?;
    let session = get_russh_session(state, link, creds).await?;
    let sftp = &session.sftp;
    let remote = if request.upload && request.comparison.is_none() {
        resolve_rename_target(&session, request.remote).await?
    } else {
        request.remote.to_string()
    };
    let transfer_signature = || async {
        let local = local_signature(request.local).await?;
        let remote = remote_signature(sftp, &remote, request.comparison.is_some()).await?;
        let (source, destination) = if request.upload {
            (local, remote)
        } else {
            (remote, local)
        };
        Ok::<_, String>((source.ok_or("源文件不存在")?, destination))
    };
    let (source, destination) = transfer_signature().await?;
    // Compare again at start: the user may have approved this plan before other queued transfers ran.
    if let Some(comparison) = &request.comparison {
        comparison.validate(source, destination)?;
    }
    if destination.is_some() && !request.overwrite {
        return Err("CCB_TARGET_EXISTS: 目标已存在同名文件".into());
    }
    if !PARTS.contains_key(id) && PARTS.len() >= 128 {
        return Err("待续传任务已达上限，请先重试或取消已有任务".into());
    }
    let cell = PARTS.entry(id.clone()).or_default().clone();
    let mut guard = cell.try_lock().map_err(|_| "该任务正在传输，请稍后再试")?;
    let outcome: Result<(), String> = async {
        if let Some(part) = guard.as_ref() {
            if !part.link.same_login(link)
                || part.local != request.local
                || part.remote != remote
                || part.upload != request.upload
            {
                return Err("传输标识与原任务不一致".into());
            }
            if part.source != source || part.destination != destination {
                return Err("源文件或目标文件已修改，请重新发起传输".into());
            }
        }
        let part = guard.get_or_insert_with(|| {
            let temp_name = format!(".cc-bridge-{}.part", uuid::Uuid::new_v4());
            let temporary = if request.upload {
                let parent = remote.rsplit_once('/').map_or("", |(parent, _)| parent);
                if parent.is_empty() && !remote.starts_with('/') {
                    temp_name
                } else {
                    format!("{parent}/{temp_name}")
                }
            } else {
                request
                    .local
                    .with_file_name(temp_name)
                    .to_string_lossy()
                    .into_owned()
            };
            Checkpoint {
                link: link.clone(),
                local: request.local.into(),
                remote: remote.clone(),
                upload: request.upload,
                temporary,
                prepared: false,
                offset: 0,
                source,
                destination,
            }
        });
        if part.upload {
            upload_part(sftp, part, hooks).await?;
        } else {
            download_part(sftp, part, hooks).await?;
        }
        if cancelled(hooks) {
            return Err("CCB_CANCELLED".into());
        }
        if part.upload {
            if remote_signature(sftp, &part.temporary, true)
                .await?
                .map(|info| info.0)
                != Some(source.0)
            {
                return Err("远程临时文件长度不一致，请重新发起传输".into());
            }
            // Keep matching copies aligned in the directory comparison. Some servers deny SETSTAT.
            if let Some(seconds) = source
                .1
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|t| u32::try_from(t.as_secs()).ok())
            {
                let attributes = FileAttributes {
                    atime: Some(seconds),
                    mtime: Some(seconds),
                    ..FileAttributes::empty()
                };
                let _ = sftp.set_metadata(part.temporary.as_str(), attributes).await;
            }
            if transfer_signature().await? != (source, destination) {
                return Err("传输期间文件已变化，请重新发起传输".into());
            }
            if cancelled(hooks) {
                return Err("CCB_CANCELLED".into());
            }
            let replaced = request.overwrite
                && destination.is_some()
                && sftp
                    .posix_rename(part.temporary.as_str(), remote.as_str())
                    .await
                    .map_err(map_sftp_err)?;
            if !replaced {
                sftp.rename(part.temporary.as_str(), remote.as_str())
                    .await
                    .map_err(map_sftp_err)?;
            }
        } else {
            if fs::metadata(&part.temporary)
                .await
                .map_err(map_sftp_err)?
                .len()
                != source.0
            {
                return Err("本机临时文件长度不一致，请重新发起传输".into());
            }
            if transfer_signature().await? != (source, destination) {
                return Err("传输期间文件已变化，请重新发起传输".into());
            }
            if cancelled(hooks) {
                return Err("CCB_CANCELLED".into());
            }
            if request.overwrite {
                fs::rename(&part.temporary, &part.local)
                    .await
                    .map_err(map_sftp_err)?;
            } else {
                super::ssh_batch_cmds::publish_without_replace(
                    Path::new(&part.temporary),
                    &part.local,
                )
                .map_err(map_sftp_err)?;
            }
        }
        hooks.emit_progress(100);
        Ok(())
    }
    .await;
    if outcome.is_ok()
        || cancelled(hooks)
        || outcome
            .as_ref()
            .is_err_and(|message| message.contains("重新发起传输"))
    {
        if let Some(part) = guard
            .as_ref()
            .filter(|part| outcome.is_err() && part.upload && part.prepared)
        {
            let _ = sftp.remove_file(part.temporary.as_str()).await;
        }
        *guard = None;
        PARTS.remove(id);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparison_blocks_writes_when_approved_source_or_destination_changed() {
        let sig = |bytes, seconds| (bytes, UNIX_EPOCH + Duration::from_secs(seconds));
        let mut plan = ComparedUpload {
            source: ComparedFile {
                size: 10,
                mtime: 100,
            },
            destination: Some(ComparedFile { size: 5, mtime: 50 }),
        };
        assert!(plan.validate(sig(10, 100), Some(sig(5, 50))).is_ok());
        assert!(plan.validate(sig(10, 101), Some(sig(5, 50))).is_err());
        assert!(plan.validate(sig(10, 100), Some(sig(5, 51))).is_err());
        assert!(plan.validate(sig(10, 100), None).is_err());
        plan.destination = None;
        assert!(plan.validate(sig(10, 100), None).is_ok());
        assert!(plan.validate(sig(10, 100), Some(sig(5, 50))).is_err());
    }

    #[tokio::test]
    async fn writes_only_remaining_bytes_and_never_advances_after_premature_eof() {
        let mut offset = 3;
        let mut buffer = Vec::from(*b"abc");
        let hooks = TransferHooks::default();
        let mut short = &b"de"[..];
        assert!(
            copy_remainder(&mut short, &mut buffer, &mut offset, 6, &hooks)
                .await
                .is_err()
        );
        assert_eq!(offset, 5);
        assert_eq!(buffer, b"abcde");
        let mut remaining = &b"f"[..];
        copy_remainder(&mut remaining, &mut buffer, &mut offset, 6, &hooks)
            .await
            .unwrap();
        assert_eq!(offset, 6);
        assert_eq!(buffer, b"abcdef");
    }
}
