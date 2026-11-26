use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri_plugin_updater::{Error as UpdaterError, Update};

const PACKAGE_FILE: &str = "update-package.bin";
const MAX_PACKAGE_BYTES: u64 = 128 * 1024 * 1024;

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
}

impl From<reqwest::Error> for PackageDownloadError {
    fn from(error: reqwest::Error) -> Self {
        Self::Updater(UpdaterError::Reqwest(error.without_url()))
    }
}

impl std::fmt::Display for PackageDownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge => write!(f, "更新包超过 {} MB", MAX_PACKAGE_BYTES / 1024 / 1024),
            Self::Updater(error) => error.fmt(f),
        }
    }
}

pub(super) async fn download_verified_package(
    app: &tauri::AppHandle,
    update: Update,
) -> Result<Vec<u8>, PackageDownloadError> {
    use reqwest::header::{HeaderValue, ACCEPT};
    let mut headers = update.headers.clone();
    headers
        .entry(ACCEPT)
        .or_insert(HeaderValue::from_static("application/octet-stream"));
    let mut client = reqwest::Client::builder()
        .user_agent(concat!("CC-Bridge/", env!("CARGO_PKG_VERSION")))
        .timeout(
            update
                .timeout
                .unwrap_or(std::time::Duration::from_secs(300)),
        );
    if update.no_proxy {
        client = client.no_proxy();
    } else if let Some(proxy) = &update.proxy {
        client = client.proxy(reqwest::Proxy::all(proxy.as_str())?);
    }
    let _ = app.emit("update:downloading", ());
    let response = client
        .build()?
        .get(update.download_url.clone())
        .headers(headers)
        .send()
        .await?
        .error_for_status()?;
    let mut last_report = std::time::Instant::now();
    let mut last_bytes = 0;
    let bytes = read_package_body(response, MAX_PACKAGE_BYTES, |downloaded, total| {
        let elapsed = last_report.elapsed();
        if elapsed.as_millis() < 250 && total != Some(downloaded as u64) {
            return;
        }
        let speed = if elapsed.is_zero() {
            0.0
        } else {
            (downloaded - last_bytes) as f64 / elapsed.as_secs_f64()
        };
        let _ = app.emit(
            "update:progress",
            serde_json::json!({
                "downloaded": downloaded, "total": total, "bytesPerSec": speed
            }),
        );
        last_report = std::time::Instant::now();
        last_bytes = downloaded;
    })
    .await?;
    let _ = app.emit("update:verifying", ());
    // The official verifier also checks the version recorded in newer signatures.
    tokio::task::spawn_blocking(move || {
        update
            .verify(&bytes)
            .map_err(PackageDownloadError::Updater)?;
        Ok(bytes)
    })
    .await
    .map_err(|err| PackageDownloadError::Updater(UpdaterError::Io(std::io::Error::other(err))))?
}

pub(super) fn package_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PACKAGE_FILE)
}

pub(super) struct PreparedUpdate {
    pub update: Update,
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

pub(super) fn persist_package(
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
