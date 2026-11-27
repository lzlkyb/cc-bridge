use std::time::Duration;

use futures_util::future::join_all;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use url::Url;

pub(super) const GITEE_REPOSITORY: &str = "lzul/cc-bridge";
pub(super) const GITHUB_REPOSITORY: &str = "lzlkyb/cc-bridge";

pub(super) fn updater(app: &tauri::AppHandle, endpoint: Option<Url>) -> Result<Updater, String> {
    let mut builder = app.updater_builder().timeout(Duration::from_secs(6));
    if let Some(endpoint) = endpoint {
        builder = builder
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())
}

fn manifest_endpoints(app: &tauri::AppHandle) -> Result<(Vec<Url>, bool), String> {
    let custom = std::env::var("CCBRIDGE_UPDATE_ENDPOINT").unwrap_or_default();
    let urls: Vec<_> = custom
        .split(',')
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .collect();
    if !urls.is_empty() {
        return urls
            .into_iter()
            .map(Url::parse)
            .collect::<Result<_, _>>()
            .map(|urls| (urls, true))
            .map_err(|error| format!("更新源配置无效: {error}"));
    }
    let mirror =
        format!("https://gitee.com/{GITEE_REPOSITORY}/raw/releases/latest/updater-gitee.json");
    let config = &app.config().plugins.0;
    let urls = config
        .get("updater")
        .and_then(|config| config["endpoints"].as_array());
    std::iter::once(mirror.as_str())
        .chain(urls.into_iter().flatten().filter_map(|item| item.as_str()))
        .map(Url::parse)
        .collect::<Result<_, _>>()
        .map(|urls| (urls, false))
        .map_err(|error| format!("更新源配置无效: {error}"))
}

pub(super) type CheckError = (String, &'static str);

/// Treat each mirror independently. A healthy reply with an old version cannot hide a newer one.
pub(super) async fn check_sources(
    app: &tauri::AppHandle,
) -> Result<(Vec<Update>, bool), CheckError> {
    let (endpoints, custom) = manifest_endpoints(app).map_err(|error| (error, "config"))?;
    let results = join_all(endpoints.into_iter().map(|endpoint| async move {
        let updater = updater(app, Some(endpoint)).map_err(|error| (error, "config"))?;
        updater.check().await.map_err(|error| {
            (
                error.to_string(),
                super::update::classify_update_error(&error),
            )
        })
    }))
    .await;
    let updates = rank_updates(results, |update| &update.version)?;
    Ok((updates, custom))
}

fn rank_updates<T>(
    results: Vec<Result<Option<T>, CheckError>>,
    version: impl Fn(&T) -> &str,
) -> Result<Vec<T>, CheckError> {
    let mut last_error = ("没有可用更新源".into(), "manifest");
    let mut successful = false;
    let mut updates = Vec::new();
    for result in results {
        match result {
            Ok(update) => {
                successful = true;
                updates.extend(update);
            }
            Err(error) => last_error = error,
        }
    }
    if !successful {
        return Err(last_error);
    }
    updates.sort_by_cached_key(|update| {
        std::cmp::Reverse(super::update_policy::parse_version(version(update)))
    });
    Ok(updates)
}

/// The official mirrors publish identical signed bytes under the same release and file name.
/// A private endpoint retains full control over its own download URLs.
fn official_package_urls(url: &Url) -> Vec<Url> {
    let raw = url.as_str();
    let github = format!("https://github.com/{GITHUB_REPOSITORY}/releases/download/");
    let proxy = format!("https://gh-proxy.com/{github}");
    let gitee = format!("https://gitee.com/{GITEE_REPOSITORY}/releases/download/");
    let suffix = [gitee.as_str(), proxy.as_str(), github.as_str()]
        .into_iter()
        .find_map(|prefix| raw.strip_prefix(prefix));
    let Some(suffix) = suffix.filter(|value| {
        value.split('/').count() == 2 && url.query().is_none() && url.fragment().is_none()
    }) else {
        return vec![url.clone()];
    };
    std::iter::once(url.clone())
        .chain(
            [gitee, proxy, github]
                .into_iter()
                .filter_map(|base| Url::parse(&(base + suffix)).ok()),
        )
        .fold(Vec::new(), |mut urls, url| {
            if !urls.contains(&url) {
                urls.push(url);
            }
            urls
        })
}

pub(super) fn download_sources(updates: Vec<Update>, custom: bool) -> Vec<Update> {
    let mut sources: Vec<Update> = Vec::new();
    // Prefer URLs actually listed in the manifests before deriving equivalent official URLs.
    for (add_alternates, candidate) in [false, true]
        .into_iter()
        .flat_map(|alternates| updates.iter().map(move |update| (alternates, update)))
    {
        if add_alternates && custom {
            break;
        }
        let urls = if add_alternates {
            official_package_urls(&candidate.download_url)
        } else {
            vec![candidate.download_url.clone()]
        };
        for url in urls {
            if sources
                .iter()
                .any(|source| source.download_url == url && source.signature == candidate.signature)
            {
                continue;
            }
            let mut update = candidate.clone();
            update.download_url = url;
            sources.push(update);
        }
    }
    sources
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_or_failed_mirror_does_not_hide_the_newer_release() {
        let sources = vec![
            Ok(None),
            Ok(Some("3.4.9")),
            Err(("proxy connection timed out".to_string(), "timeout")),
            Ok(Some("3.4.10")),
        ];
        assert_eq!(
            rank_updates(sources, |version| version).unwrap(),
            ["3.4.10", "3.4.9"]
        );
    }

    #[test]
    fn official_proxy_has_a_real_direct_download_fallback() {
        let direct = format!(
            "https://github.com/{GITHUB_REPOSITORY}/releases/download/v3.5.0/cc-bridge.app.tar.gz"
        );
        let proxy = format!("https://gh-proxy.com/{direct}");
        let urls = official_package_urls(&Url::parse(&proxy).unwrap());
        assert_eq!(urls.len(), 3);
        assert_eq!(urls.last().unwrap().as_str(), direct);
        let other =
            Url::parse("https://github.com/other/repo/releases/download/v3.5.0/app.exe").unwrap();
        assert_eq!(official_package_urls(&other), vec![other]);
    }
}
