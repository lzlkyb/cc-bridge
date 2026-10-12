//! P1 HTTPS 远程连接：自签证书生成/复用 + TLS serve 分支。
//!
//! 设计要点（proposals/p1_https_tls_plan.md）：
//! - 证书与私钥落在 `<data_dir>/certs/`，配套 `meta.json` 记录指纹/SAN/到期——
//!   用 meta 判断复用，避免引入 x509-parser（证书与 meta 同步生成，一致性由
//!   「任一缺失即重生成」保证，重生成无副作用）。
//! - SAN = 传入的全部网卡 IP + 127.0.0.1；CN 固定 `cc-bridge`（身份靠 SAN 与指纹）。
//! - 复用条件：三件套齐全 且 SAN 与当前 IP 集合一致 且 距到期 > 30 天；否则重生成。
//! - 指纹 = 证书 DER 的 SHA-256（hex 小写），设置页展示、client 侧核对。

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// 证书有效期（天）。825 天——非浏览器场景（MCP client 不做 398 天限制校验），
/// 取长些减少用户「证书过期连不上」的意外。
const CERT_VALID_DAYS: i64 = 825;
/// 距到期不足该天数时自动重生成。
const REGEN_AHEAD_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// 证书 DER 的 SHA-256，hex 小写（64 字符）。
    pub fingerprint_sha256: String,
    /// 到期时间（Unix 秒）。
    pub not_after_epoch: i64,
    /// SAN 列表（IP 字符串，含 127.0.0.1）。
    pub sans: Vec<String>,
    pub common_name: String,
    /// 本次调用是否发生了重新生成。
    pub regenerated: bool,
    /// 重生成原因（复用时为 None）。
    pub regenerate_reason: Option<String>,
}

impl CertInfo {
    /// 指纹短格式（前 16 hex + …），设置页列表展示用；完整指纹 hover 展示。
    pub fn fingerprint_short(&self) -> String {
        let mut s = self.fingerprint_sha256.clone();
        s.truncate(16);
        format!("{}…", s)
    }
}

fn certs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("certs")
}

fn cert_paths(data_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let dir = certs_dir(data_dir);
    (
        dir.join("self-signed.crt"),
        dir.join("self-signed.key"),
        dir.join("meta.json"),
    )
}

/// 探测本机全部 IPv4 地址（跨网卡，去重排序；不含 loopback——由调用方单独补 127.0.0.1）。
pub fn detect_local_ips() -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = match if_addrs::get_if_addrs() {
        Ok(ifas) => ifas
            .into_iter()
            .filter(|iface| matches!(iface.ip(), IpAddr::V4(_)) && !iface.ip().is_loopback())
            .map(|iface| iface.ip())
            .collect(),
        Err(e) => {
            log::warn!("网卡 IP 探测失败（将只用 127.0.0.1 生成证书）：{}", e);
            Vec::new()
        }
    };
    ips.sort();
    ips.dedup();
    ips
}

/// 确保证书可用（复用或重生成），返回证书信息。
pub fn ensure_cert(data_dir: &Path, ips: &[IpAddr]) -> std::io::Result<CertInfo> {
    let (crt, key, meta) = cert_paths(data_dir);
    let mut wanted: Vec<String> = ips.iter().map(|i| i.to_string()).collect();
    wanted.push("127.0.0.1".into());
    wanted.sort();
    wanted.dedup();

    // 复用判断：三件套齐全 + meta 的 SAN 一致 + 距到期 > 30 天。
    if let (Ok(c), Ok(k), Ok(m)) = (
        std::fs::read_to_string(&crt),
        std::fs::read(&key),
        std::fs::read_to_string(&meta),
    ) {
        let _ = c;
        let _ = k;
        if let Ok(m) = serde_json::from_str::<CertInfoMeta>(&m) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let regen_deadline = now + REGEN_AHEAD_DAYS * 86_400;
            if m.sans == wanted && m.not_after_epoch > regen_deadline {
                return Ok(CertInfo {
                    fingerprint_sha256: m.fingerprint_sha256,
                    not_after_epoch: m.not_after_epoch,
                    sans: m.sans,
                    common_name: m.common_name,
                    regenerated: false,
                    regenerate_reason: None,
                });
            }
            return regenerate(
                data_dir,
                &wanted,
                if m.sans != wanted {
                    "本机 IP 集合变化"
                } else {
                    "证书临近到期"
                },
            );
        }
    }
    regenerate(data_dir, &wanted, "首次生成或证书文件缺失")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CertInfoMeta {
    fingerprint_sha256: String,
    not_after_epoch: i64,
    sans: Vec<String>,
    common_name: String,
}

fn regenerate(data_dir: &Path, sans: &[String], reason: &str) -> std::io::Result<CertInfo> {
    let (crt, key, meta) = cert_paths(data_dir);
    std::fs::create_dir_all(certs_dir(data_dir))?;

    let ips: Vec<std::net::IpAddr> = sans.iter().filter_map(|s| s.parse().ok()).collect();

    let mut params = rcgen::CertificateParams::new(vec![]).map_err(io_err("证书参数构造失败"))?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "cc-bridge");
    params.subject_alt_names = ips
        .iter()
        .map(|ip| rcgen::SanType::IpAddress(*ip))
        .collect();
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    params.not_before = unix_to_offset(now_unix - 86_400); // 回拨 1 天容忍时钟偏移
    params.not_after = unix_to_offset(now_unix + CERT_VALID_DAYS * 86_400);
    let not_after_epoch = now_unix + CERT_VALID_DAYS * 86_400;

    let key_pair = rcgen::KeyPair::generate().map_err(io_err("密钥生成失败"))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(io_err("自签证书签发失败"))?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    std::fs::write(&crt, &cert_pem)?;
    write_private(&key, &key_pem)?;

    let fingerprint = sha256_hex(cert.der().as_ref());
    let info = CertInfo {
        fingerprint_sha256: fingerprint.clone(),
        not_after_epoch,
        sans: sans.to_vec(),
        common_name: "cc-bridge".into(),
        regenerated: true,
        regenerate_reason: Some(reason.into()),
    };
    let meta_json = serde_json::to_string_pretty(&CertInfoMeta {
        fingerprint_sha256: fingerprint,
        not_after_epoch,
        sans: sans.to_vec(),
        common_name: "cc-bridge".into(),
    })
    .map_err(|e| std::io::Error::other(format!("meta 序列化失败：{}", e)))?;
    std::fs::write(&meta, meta_json)?;

    log::info!(
        "自签证书已{}（{}，到期 epoch {}）",
        if reason == "首次生成或证书文件缺失" {
            "生成"
        } else {
            "重新生成"
        },
        reason,
        not_after_epoch
    );
    Ok(info)
}

/// 读取证书 PEM 文本（接入向导「复制 PEM」步骤用）。文件缺失时返回原始 IO 错误。
pub fn read_cert_pem(data_dir: &Path) -> std::io::Result<String> {
    let (crt, _, _) = cert_paths(data_dir);
    std::fs::read_to_string(&crt)
}

/// 从磁盘载入证书与私钥，构造 axum-server 的 RustlsConfig。
pub async fn load_rustls_config(
    data_dir: &Path,
) -> Result<axum_server::tls_rustls::RustlsConfig, String> {
    install_crypto_provider();
    let (crt, key, _) = cert_paths(data_dir);
    let cert_pem = std::fs::read_to_string(&crt).map_err(|e| format!("读取证书失败：{}", e))?;
    let key_pem = std::fs::read_to_string(&key).map_err(|e| format!("读取私钥失败：{}", e))?;
    let certs: Vec<_> = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<_, _>>()
        .map_err(|e| format!("解析证书失败：{}", e))?;
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|e| format!("解析私钥失败：{}", e))?
        .ok_or("私钥为空")?;
    // axum-server 0.8 的 from_der 收裸字节（Vec<Vec<u8>> / Vec<u8>）。
    let cert_ders: Vec<Vec<u8>> = certs.iter().map(|c| c.as_ref().to_vec()).collect();
    let key_der = key.secret_der().to_vec();
    axum_server::tls_rustls::RustlsConfig::from_der(cert_ders, key_der)
        .await
        .map_err(|e| format!("构造 TLS 配置失败：{}", e))
}

/// rustls 0.23 需要 CryptoProvider；进程内幂等安装（tauri 生态可能已有别的 provider 装过）。
pub fn install_crypto_provider() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

fn unix_to_offset(unix_secs: i64) -> time::OffsetDateTime {
    time::OffsetDateTime::from_unix_timestamp(unix_secs).unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
}

fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    std::fs::write(path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn io_err(msg: &'static str) -> impl Fn(rcgen::Error) -> std::io::Error {
    move |e| std::io::Error::other(format!("{}：{}", msg, e))
}

/// 生成 serve 用的 keep-alive（占位：暂无特殊需求）。
#[allow(dead_code)]
pub(crate) const TLS_KEEPALIVE: Option<Duration> = Some(Duration::from_secs(60));

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("ccbridge-tls-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn first_generate_then_reuse() {
        let dir = temp_dir("reuse");
        let info = ensure_cert(&dir, &[]).expect("首次生成");
        assert!(info.regenerated);
        assert_eq!(info.common_name, "cc-bridge");
        assert!(info.sans.contains(&"127.0.0.1".to_string()));
        assert_eq!(info.fingerprint_sha256.len(), 64);

        // 第二次：复用（无重生成原因）。
        let again = ensure_cert(&dir, &[]).expect("复用");
        assert!(!again.regenerated);
        assert_eq!(again.fingerprint_sha256, info.fingerprint_sha256);
        assert_eq!(again.not_after_epoch, info.not_after_epoch);
    }

    #[test]
    fn ip_change_triggers_regeneration() {
        let dir = temp_dir("ipchange");
        let first = ensure_cert(&dir, &[]).expect("首次");
        let second = ensure_cert(&dir, &[IpAddr::from([192, 168, 1, 7])]).expect("IP 变化");
        assert!(second.regenerated);
        assert_eq!(
            second.regenerate_reason.as_deref(),
            Some("本机 IP 集合变化")
        );
        assert_ne!(second.fingerprint_sha256, first.fingerprint_sha256);
        assert!(second.sans.contains(&"192.168.1.7".to_string()));
        assert!(second.sans.contains(&"127.0.0.1".to_string()));
    }

    #[test]
    fn near_expiry_triggers_regeneration() {
        let dir = temp_dir("expiry");
        ensure_cert(&dir, &[]).expect("首次");
        // 篡改 meta：把到期拨到 20 天后（< 30 天阈值）→ 应触发重生成。
        let (_, _, meta) = cert_paths(&dir);
        let mut m: CertInfoMeta =
            serde_json::from_str(&std::fs::read_to_string(&meta).unwrap()).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        m.not_after_epoch = now + 20 * 86_400;
        std::fs::write(&meta, serde_json::to_string(&m).unwrap()).unwrap();

        let again = ensure_cert(&dir, &[]).expect("临近到期重生成");
        assert!(again.regenerated);
        assert_eq!(again.regenerate_reason.as_deref(), Some("证书临近到期"));
        assert!(again.not_after_epoch > now + 800 * 86_400);
    }

    #[test]
    fn missing_meta_regenerates() {
        let dir = temp_dir("nometa");
        ensure_cert(&dir, &[]).expect("首次");
        let (_, _, meta) = cert_paths(&dir);
        std::fs::remove_file(&meta).unwrap();
        let again = ensure_cert(&dir, &[]).expect("meta 缺失重生成");
        assert!(again.regenerated);
    }

    #[test]
    fn server_config_loads_from_disk() {
        let dir = temp_dir("loadcfg");
        ensure_cert(&dir, &[]).expect("生成");
        // 能构造 RustlsConfig（证书/私钥格式被 rustls 接受）。需要 tokio runtime（from_der async）。
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async { load_rustls_config(&dir).await.expect("载入 RustlsConfig") });
    }

    #[test]
    fn fingerprint_short_truncates() {
        let dir = temp_dir("short");
        let info = ensure_cert(&dir, &[]).unwrap();
        let short = info.fingerprint_short();
        assert!(short.ends_with("…"));
        assert_eq!(short.chars().count(), 17); // 16 hex + …
    }

    #[test]
    fn read_cert_pem_returns_pem_text() {
        let dir = temp_dir("pem");
        ensure_cert(&dir, &[]).expect("生成");
        let pem = read_cert_pem(&dir).expect("读取 PEM");
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(pem.trim_end().ends_with("-----END CERTIFICATE-----"));
    }

    #[test]
    fn read_cert_pem_missing_file_errors() {
        let dir = temp_dir("pem-missing");
        assert!(read_cert_pem(&dir).is_err());
    }
}
