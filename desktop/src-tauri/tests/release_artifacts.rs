use base64::prelude::*;
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::{fs, path::Path};

fn read_signature(encoded: &str) -> Signature {
    let text = String::from_utf8(BASE64_STANDARD.decode(encoded.trim()).unwrap()).unwrap();
    Signature::decode(&text).unwrap()
}

#[test]
#[ignore = "requires the complete artifacts collected by the release workflow"]
fn verify_release_artifacts() {
    let dir = std::env::var("CCBRIDGE_RELEASE_VERIFY_DIR").unwrap();
    let dir = Path::new(&dir);
    let read = |name: &str| fs::read(dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    let version = env!("CARGO_PKG_VERSION");
    assert_eq!(
        std::env::var("CCBRIDGE_RELEASE_TAG").unwrap(),
        format!("v{version}")
    );
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let key = String::from_utf8(BASE64_STANDARD.decode(key).unwrap()).unwrap();
    let key = PublicKey::decode(&key).unwrap();
    let manifest: Value = serde_json::from_slice(&read("updater.json")).unwrap();
    assert_eq!(manifest["version"], version);
    for (target, name) in [
        (
            "windows-x86_64",
            format!("cc-bridge_{version}_x64-setup.exe"),
        ),
        ("darwin-aarch64", "cc-bridge.app.tar.gz".into()),
    ] {
        let asset = &manifest["platforms"][target];
        let url = url::Url::parse(asset["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "https");
        assert!(url.path().ends_with(&format!("/v{version}/{name}")));
        let signature = asset["signature"].as_str().unwrap();
        assert_eq!(
            String::from_utf8(read(&format!("{name}.sig")))
                .unwrap()
                .trim(),
            signature.trim()
        );
        let signature = read_signature(signature);
        let bytes = read(&name);
        assert!(bytes.len() <= 128 * 1024 * 1024);
        key.verify(&bytes, &signature, true)
            .expect("installed artifact signature");
        assert!(signature
            .trusted_comment()
            .split('\t')
            .any(|part| part == format!("version:{version}")));
    }
    for platform in ["x86_64-pc-windows-msvc", "aarch64-apple-darwin"] {
        assert!(read(&format!("cc-bridge_{version}_{platform}.zip")).starts_with(b"PK\x03\x04"));
    }
    let policy: Value = serde_json::from_slice(&read("update-policy.json")).unwrap();
    let payload = policy["payload"].as_str().unwrap();
    let signature = read_signature(policy["signature"].as_str().unwrap());
    key.verify(payload.as_bytes(), &signature, true)
        .expect("update policy signature");
    let policy: Value = serde_json::from_str(
        payload
            .strip_prefix("CC Bridge update policy v1\n")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(policy["latestVersion"], version);
    let at = |field: &str| {
        chrono::DateTime::parse_from_rfc3339(policy[field].as_str().unwrap()).unwrap()
    };
    assert!(at("expiresAt") > at("graceUntil"));
    assert!(at("expiresAt") > chrono::Utc::now());
}
