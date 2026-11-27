use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri_plugin_updater::{Error as UpdaterError, Update};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const PACKAGE_FILE: &str = "update-package.bin";
const MAX_PACKAGE_BYTES: u64 = 128 * 1024 * 1024;
const ID_BYTES: u64 = 32;

async fn read_package_body(
    mut response: reqwest::Response,
    limit: u64,
    mut progress: impl FnMut(usize, Option<u64>),
) -> Result<Vec<u8>, PackageDownloadError> {
    let length = response.content_length();
    if length.is_some_and(|length| length > limit) {
        return Err(PackageDownloadError::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() as u64 > limit.saturating_sub(bytes.len() as u64) {
            return Err(PackageDownloadError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len(), length);
    }
    Ok(bytes)
}

#[derive(Debug)]
pub(super) enum PackageDownloadError {
    TooLarge,
    Updater(UpdaterError),
    InvalidRange,
}

impl From<reqwest::Error> for PackageDownloadError {
    fn from(error: reqwest::Error) -> Self {
        Self::Updater(UpdaterError::Reqwest(error.without_url()))
    }
}

impl From<std::io::Error> for PackageDownloadError {
    fn from(error: std::io::Error) -> Self {
        Self::Updater(UpdaterError::Io(error))
    }
}

impl std::fmt::Display for PackageDownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge => write!(f, "更新包超过 {} MB", MAX_PACKAGE_BYTES / 1024 / 1024),
            Self::Updater(error) => error.fmt(f),
            Self::InvalidRange => write!(f, "更新源返回的续传范围不完整"),
        }
    }
}

pub(super) async fn download_verified_package(
    app: &tauri::AppHandle,
    update: Update,
    cache: &Path,
) -> Result<Vec<u8>, PackageDownloadError> {
    use reqwest::header::{HeaderValue, ACCEPT, ACCEPT_ENCODING};
    let mut headers = update.headers.clone();
    headers
        .entry(ACCEPT)
        .or_insert(HeaderValue::from_static("application/octet-stream"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    let mut client = reqwest::Client::builder()
        .user_agent(concat!("CC-Bridge/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(8))
        .read_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180));
    if update.no_proxy {
        client = client.no_proxy();
    } else if let Some(proxy) = &update.proxy {
        client = client.proxy(reqwest::Proxy::all(proxy.as_str())?);
    }
    let _ = app.emit("update:downloading", ());
    let request = client
        .build()?
        .get(update.download_url.clone())
        .headers(headers);
    let partial_path = cache.with_extension("part");
    let id = package_id(&update.version, &update.signature);
    let mut last_report = std::time::Instant::now();
    let mut last_bytes = None;
    let report = |downloaded: usize, total: Option<u64>| {
        let previous = last_bytes.get_or_insert(downloaded);
        let elapsed = last_report.elapsed();
        if elapsed.as_millis() < 250 && total != Some(downloaded as u64) {
            return;
        }
        let speed = if elapsed.is_zero() {
            0.0
        } else {
            downloaded.saturating_sub(*previous) as f64 / elapsed.as_secs_f64()
        };
        let _ = app.emit(
            "update:progress",
            serde_json::json!({
                "downloaded": downloaded, "total": total, "bytesPerSec": speed
            }),
        );
        last_report = std::time::Instant::now();
        *previous = downloaded;
    };
    let bytes = match open_partial(&partial_path, &id).await {
        Ok((file, offset)) => transfer_partial(request, file, offset, &id, report).await?,
        Err(error) => {
            // A read-only profile can still download and install during this run.
            log::warn!("[Update] 本地续传缓存不可用: {error}");
            read_package_body(
                request.send().await?.error_for_status()?,
                MAX_PACKAGE_BYTES,
                report,
            )
            .await?
        }
    };
    let _ = app.emit("update:verifying", ());
    // The official verifier also checks the version recorded in newer signatures.
    let result = tokio::task::spawn_blocking(move || {
        update
            .verify(&bytes)
            .map_err(PackageDownloadError::Updater)?;
        Ok(bytes)
    })
    .await
    .map_err(std::io::Error::other)?;
    // Only complete, verified packages may move into the install cache. A failed signature
    // also clears the partial so a subsequent mirror can start with clean bytes.
    let _ = tokio::fs::remove_file(&partial_path).await;
    result
}

async fn open_partial(path: &Path, id: &[u8; 32]) -> std::io::Result<(tokio::fs::File, u64)> {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .await?;
    let len = file.metadata().await?.len();
    let mut saved_id = [0; 32];
    let offset = if (ID_BYTES..=ID_BYTES + MAX_PACKAGE_BYTES).contains(&len)
        && file.read_exact(&mut saved_id).await.is_ok()
        && saved_id == *id
    {
        len - ID_BYTES
    } else {
        reset_partial(&mut file, id).await?;
        0
    };
    file.seek(std::io::SeekFrom::Start(ID_BYTES + offset))
        .await?;
    Ok((file, offset))
}

async fn reset_partial(file: &mut tokio::fs::File, id: &[u8; 32]) -> std::io::Result<()> {
    file.set_len(0).await?;
    file.seek(std::io::SeekFrom::Start(0)).await?;
    file.write_all(id).await?;
    file.flush().await
}

fn resumed_size(value: &str, offset: u64) -> Option<u64> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let total: u64 = total.parse().ok()?;
    let start: u64 = start.parse().ok()?;
    let end: u64 = end.parse().ok()?;
    (start == offset && start <= end && end.checked_add(1) == Some(total)).then_some(total)
}

async fn transfer_partial(
    request: reqwest::RequestBuilder,
    mut file: tokio::fs::File,
    mut offset: u64,
    id: &[u8; 32],
    mut report: impl FnMut(usize, Option<u64>),
) -> Result<Vec<u8>, PackageDownloadError> {
    use reqwest::{header, StatusCode};
    let mut response = if offset > 0 {
        request
            .try_clone()
            .expect("GET has no streaming request body")
            .header(header::RANGE, format!("bytes={offset}-"))
            .send()
            .await?
    } else {
        request
            .try_clone()
            .expect("GET has no streaming request body")
            .send()
            .await?
    };
    if offset > 0 && response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
        reset_partial(&mut file, id).await?;
        offset = 0;
        response = request.send().await?;
    }
    let mut response = response.error_for_status()?;
    let total = if response.status() == StatusCode::PARTIAL_CONTENT {
        let total = response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|value| resumed_size(value, offset))
            .ok_or(PackageDownloadError::InvalidRange)?;
        Some(total)
    } else {
        // Gitee and some proxies ignore Range and send a full response.
        if offset > 0 {
            reset_partial(&mut file, id).await?;
            offset = 0;
        }
        response.content_length()
    };
    if total.is_some_and(|length| length > MAX_PACKAGE_BYTES) {
        return Err(PackageDownloadError::TooLarge);
    }
    let mut downloaded = offset;
    report(downloaded as usize, total);
    while let Some(chunk) = response.chunk().await? {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_PACKAGE_BYTES {
            return Err(PackageDownloadError::TooLarge);
        }
        file.write_all(&chunk).await?;
        // Flush each chunk so dropping this future preserves exactly the bytes it advertised.
        file.flush().await?;
        report(downloaded as usize, total);
    }
    if total.is_some_and(|length| length != downloaded) {
        return Err(PackageDownloadError::InvalidRange);
    }
    file.seek(std::io::SeekFrom::Start(ID_BYTES)).await?;
    let mut bytes = Vec::with_capacity(downloaded as usize);
    file.take(MAX_PACKAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 != downloaded {
        return Err(PackageDownloadError::InvalidRange);
    }
    Ok(bytes)
}

pub(crate) fn package_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PACKAGE_FILE)
}

pub(super) fn save_metadata(path: &Path, update: &Update) -> std::io::Result<()> {
    let tmp = path.with_extension("manifest.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&update.raw_json)?)?;
    std::fs::rename(&tmp, path.with_extension("manifest.json"))
}

pub(super) fn read_metadata(path: &Path) -> Option<serde_json::Value> {
    let file = std::fs::File::open(path.with_extension("manifest.json")).ok()?;
    serde_json::from_reader(file.take(1024 * 1024)).ok()
}

/// The stale manifest must describe the bytes in the cache. A sidecar from a failed
/// write must never cause a newer package to be discarded.
pub(crate) fn obsolete_package(path: &Path, current: &semver::Version) -> bool {
    let Some(raw) = read_metadata(path) else {
        return false;
    };
    let Some(version) = raw.get("version").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let Ok(release) = semver::Version::parse(version.trim_start_matches('v')) else {
        return false;
    };
    if release.cmp_precedence(current).is_gt() {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; ID_BYTES as usize];
    if file.read_exact(&mut header).is_err() {
        return false;
    }
    let matches = |value: &serde_json::Value| {
        value
            .get("signature")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|signature| {
                header == package_id(version.trim_start_matches('v'), signature)
            })
    };
    matches(&raw)
        || raw
            .get("platforms")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|platforms| platforms.values().any(matches))
}

pub(super) struct PreparedUpdate {
    pub update: Update,
    pub size: usize,
    // Drop the installer bytes after persisting them. An unwritable cache must not
    // force the user to download a second time within this session.
    pub memory: Option<Arc<[u8]>>,
    pub path: PathBuf,
}

fn package_id(version: &str, signature: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(version.as_bytes());
    hash.update([0]);
    hash.update(signature.as_bytes());
    hash.finalize().into()
}

pub(super) fn cached_package(
    path: &Path,
    version: &str,
    signature: &str,
    verify: impl FnOnce(&[u8]) -> bool,
) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut id = [0; 32];
    file.read_exact(&mut id).ok()?;
    if id != package_id(version, signature) {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_PACKAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return None;
    }
    verify(&bytes).then_some(bytes)
}

pub(crate) fn persist_package(
    path: &Path,
    version: &str,
    signature: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    if bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(std::io::Error::other("更新包超出缓存上限"));
    }
    let temp = path.with_extension("tmp");
    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(&package_id(version, signature))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resumes_matching_bytes_and_restarts_when_mirror_ignores_range() {
        use axum::{
            http::{header, HeaderMap, StatusCode},
            response::IntoResponse,
        };
        let router = axum::Router::new()
            .route(
                "/range",
                axum::routing::get(|headers: HeaderMap| async move {
                    assert_eq!(headers[header::RANGE], "bytes=4-");
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [(header::CONTENT_RANGE, "bytes 4-7/8")],
                        "5678",
                    )
                        .into_response()
                }),
            )
            .route("/full", axum::routing::get(|| async { "12345678" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let dir = crate::mcp::tools::testutil::unique_subdir("update-partial");
        let path = dir.join("partial");
        let id = package_id("3.4.1", "same-signature");
        for route in ["range", "full"] {
            let (mut file, _) = open_partial(&path, &id).await.unwrap();
            reset_partial(&mut file, &id).await.unwrap();
            file.write_all(b"1234").await.unwrap();
            file.flush().await.unwrap();
            drop(file);
            let (file, offset) = open_partial(&path, &id).await.unwrap();
            assert_eq!(offset, 4);
            let request = reqwest::Client::new().get(format!("http://{addr}/{route}"));
            let bytes = transfer_partial(request, file, offset, &id, |_, _| {})
                .await
                .unwrap();
            assert_eq!(bytes, b"12345678");
        }
        assert_eq!(
            open_partial(&path, &package_id("3.4.2", "different-signature"))
                .await
                .unwrap()
                .1,
            0
        );
        server.abort();
    }

    #[tokio::test]
    async fn rejects_oversized_body_even_without_content_length() {
        use axum::body::{Body, Bytes};
        let router = axum::Router::new().route(
            "/",
            axum::routing::get(|| async {
                Body::from_stream(futures_util::stream::iter([
                    Ok::<_, std::io::Error>(Bytes::from_static(b"1234")),
                    Ok(Bytes::from_static(b"5678")),
                ]))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let response = reqwest::get(format!("http://{addr}")).await.unwrap();
        assert!(response.content_length().is_none());
        let result = read_package_body(response, 6, |_, _| {}).await;
        server.abort();
        assert!(matches!(result, Err(PackageDownloadError::TooLarge)));
    }

    #[test]
    fn package_identity_includes_version_and_signature() {
        assert_ne!(package_id("3.4.1", "a"), package_id("3.4.2", "a"));
        assert_ne!(package_id("3.4.1", "a"), package_id("3.4.1", "b"));
    }

    #[test]
    fn reloads_cache_only_after_verifying_payload() {
        let signature = "test-signature";
        let verify = |bytes: &[u8]| bytes == b"test";
        let root = crate::mcp::tools::testutil::unique_subdir("update-cache");
        let path = package_path(&root);
        persist_package(&path, "3.4.1", signature, b"test").unwrap();
        assert_eq!(
            cached_package(&path, "3.4.1", signature, verify).as_deref(),
            Some(b"test".as_slice())
        );
        assert!(cached_package(&path, "3.4.2", signature, |_| panic!(
            "旧版本不得进入安装校验"
        ))
        .is_none());
        persist_package(&path, "3.4.1", signature, b"Test").unwrap();
        assert!(cached_package(&path, "3.4.1", signature, verify).is_none());
        let _ = std::fs::remove_file(path);
    }
}
