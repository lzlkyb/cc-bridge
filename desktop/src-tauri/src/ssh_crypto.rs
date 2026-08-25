//! SSH「记住密码」的加密落盘（S1：凭据只经 Tauri IPC 写入本机，明文不出本地进程）。
//!
//! 设计：每条 SSH 连接的密码以 aes-gcm 密文（`encrypted_password`）存进配置库；
//! 对称密钥存 `data_dir/ssh_key.bin`（每安装随机生成一次）。密钥从不进配置库、
//! 不进 MCP、不进任何网络响应。明文密码仅在 `ssh_connect` 自动填充的那一瞬存在于内存。
//!
//! 强度说明：密钥文件位于 `data_dir`（与 SQLite 库同级，本就是当前用户私有目录），
//! 等价于「文件级保护」，弱于 OS 凭据库（DPAPI/Keychain）但零新重依赖、跨平台一致。
//! 后续若要把密钥收进 OS 凭据库，只改 `load_or_create_key` 一处即可，调用方不变。

use std::path::Path;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::RngCore;

const KEY_FILE: &str = "ssh_key.bin";
const NONCE_LEN: usize = 12;

/// 读取或创建 SSH 对称密钥（32 字节）。
///
/// 文件不存在时随机生成并写入 `data_dir/ssh_key.bin`。密钥只留在本地文件，绝不出进程。
pub fn load_or_create_key(data_dir: &Path) -> Result<[u8; 32], String> {
    let path = data_dir.join(KEY_FILE);
    if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取 SSH 密钥失败：{e}"))?;
        if bytes.len() != 32 {
            // 🔴 错误信息必须给出路。解密与保存走的是同一个函数，这里一直报错
            // 就意味着「记住密码」彻底锁死：既取不回旧密码，也存不了新密码。
            // 只说「长度异常」而不说怎么办，用户只能卡死在这里。
            return Err(format!(
                "SSH 密钥文件已损坏（应为 32 字节，实为 {} 字节）：{}\n\
                 删除该文件可恢复功能，代价是已保存的 SSH 密码 / 密码短语将无法解密，需重新输入。",
                bytes.len(),
                path.display()
            ));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    write_atomically(&path, &key)?;
    // data_dir 本身已是当前用户私有目录（与 SQLite 库同级），密钥文件落在其中即受同等保护。
    Ok(key)
}

/// 原子落盘：先写同目录临时文件，再 `rename` 覆盖目标。
///
/// 🔴 直接 `fs::write` 到目标路径**不是原子的**：写到一半失败（磁盘写满、
/// 进程被杀）会留下一个不足 32 字节的残缺密钥文件，而 `load_or_create_key`
/// 见到长度异常就永远返回 Err——于是「记住密码」被永久锁死。
/// 这不是理论风险：本机刚发生过 C 盘写满导致构建报 `no space on device`。
///
/// 同目录 rename 在 Windows 与 Unix 上都是原子替换。
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入 SSH 密钥临时文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        // rename 失败就把临时文件清掉，不留垃圾。
        let _ = std::fs::remove_file(&tmp);
        format!("落盘 SSH 密钥失败：{e}")
    })
}

/// 用密钥加密明文密码，返回 base64(nonce(12B) || ciphertext)。
pub fn encrypt_password(key: &[u8; 32], pw: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化加密器失败：{e}"))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, pw.as_bytes())
        .map_err(|e| format!("加密密码失败：{e}"))?;
    let mut buf = Vec::with_capacity(NONCE_LEN + ct.len());
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ct);
    Ok(B64.encode(&buf))
}

/// 解密 `encrypt_password` 产物为明文密码。失败返回明确错误（密钥/密文损坏）。
pub fn decrypt_password(key: &[u8; 32], s: &str) -> Result<String, String> {
    let buf = B64
        .decode(s)
        .map_err(|e| format!("密文 base64 解码失败：{e}"))?;
    if buf.len() < NONCE_LEN {
        return Err("密文长度异常".into());
    }
    let (nonce_bytes, ct) = buf.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化解密器失败：{e}"))?;
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "密码解密失败（密钥或密文损坏）".to_string())?;
    String::from_utf8(pt).map_err(|e| format!("密码解码失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = [7u8; 32];
        let pw = "S3cret!密码🔒";
        let ct = encrypt_password(&key, pw).expect("encrypt");
        assert_ne!(ct, pw, "密文不应等于明文");
        let back = decrypt_password(&key, &ct).expect("decrypt");
        assert_eq!(back, pw, "解密应还原明文");
    }

    /// 密钥文件损坏时，错误信息必须**给出路**：指明是哪个文件 + 删它能恢复。
    ///
    /// 🔴 解密与保存走的是同一个 `load_or_create_key`，这里一直报错就意味着
    /// 「记住密码」被永久锁死。只说「长度异常」，用户只能卡死在这里。
    #[test]
    fn corrupted_key_file_reports_how_to_recover() {
        let dir = std::env::temp_dir().join(format!("ccb_sshkey_bad_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join(KEY_FILE), b"short").expect("write");
        let e = load_or_create_key(&dir).expect_err("残缺密钥必须报错");
        assert!(e.contains(KEY_FILE), "错误得指明是哪个文件：{e}");
        assert!(e.contains("删除"), "错误得告诉用户怎么恢复：{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 正常路径：首次生成并落盘，二次读回同一把钥匙；不能留下临时文件。
    #[test]
    fn key_is_created_once_and_reused() {
        let dir = std::env::temp_dir().join(format!("ccb_sshkey_ok_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let k1 = load_or_create_key(&dir).expect("首次生成");
        let k2 = load_or_create_key(&dir).expect("二次读回");
        assert_eq!(k1, k2, "同一 data_dir 必须拿到同一把钥匙，否则旧密文全部解不开");
        assert!(
            !dir.join("ssh_key.bin.tmp").exists(),
            "原子落盘后不应残留临时文件"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 密文被截断 / 不是 base64 / 短于一个 nonce——都要报错而不是 panic。
    #[test]
    fn malformed_ciphertext_errors_instead_of_panicking() {
        let key = [3u8; 32];
        let good = encrypt_password(&key, "pw").expect("encrypt");
        for bad in [
            String::new(),
            "!!!not base64!!!".to_string(),
            B64.encode([0u8; 5]),               // 比 nonce 还短
            good[..good.len() - 4].to_string(), // 截断
        ] {
            assert!(decrypt_password(&key, &bad).is_err(), "{bad:?} 应报错");
        }
    }

    #[test]
    fn wrong_key_fails() {
        let ct = encrypt_password(&[1u8; 32], "hello").expect("encrypt");
        assert!(
            decrypt_password(&[2u8; 32], &ct).is_err(),
            "错误密钥必须解密失败"
        );
    }
}
