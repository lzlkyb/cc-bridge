//! 中转配置一键部署到远端（P1）。
//!
//! 收口三个复发问题：配置路径漂移（alias 与编辑的文件不一致）、属主锁
//! （claude 以服务账号运行写 settings → chmod 600 → ACL mask::--- 锁登录用户）、
//! 地址错（BASE_URL 不随模式变）。做法：经所选 SSH 连接以**连接用户**身份，
//! 把按当前模式算好 BASE_URL 的 own-model.json 写到该用户家目录的固定路径，
//! 设 ACL 让 claude 服务账号读得到，并**幂等**对齐 claude-own alias。
//!
//! 🔴 不写死用户名/家目录：路径相对连接用户的 `$HOME`，alias 用 tilde 可移植形式。
//! 🔴 不碰 claude-svc 全局配置（登录用户无写权限且影响全员）。

use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::State;

use super::ssh_cmds::{
    find_ssh, resolve_link_secrets, run_via_helper, spawn_capture_off_runtime, ssh_base_args,
    SshLink,
};
use crate::db::{get_config_value, set_config_value};
use crate::relay::config::DEFAULT_PORT;
use crate::state::{relay_listen_host, AppState};

const DEFAULT_MODEL: &str = "claude-sonnet-5-5";
const ALIAS_LINE: &str = "alias claude-own='claude --settings ~/.claude-own/own-model.json'";
const LAST_DEPLOY_KEY: &str = "relay_last_deploy";

/// BASE_URL 随模式算（纯函数，可单测）。
///
/// direct → `http://<LAN IP>:4100`；tunnel → `http://127.0.0.1:<隧道端口>`。
/// 隧道端口为 0（尚未分配）时报错，不静默给一个连不上的地址。
pub(super) fn deploy_base_url(
    mode: &str,
    lan_host: &str,
    tunnel_port: u16,
) -> Result<String, String> {
    if mode == "direct" {
        Ok(format!("http://{lan_host}:{DEFAULT_PORT}"))
    } else if tunnel_port == 0 {
        Err("该连接尚未分配隧道端口，请先在中转接入页接入隧道再部署。".into())
    } else {
        Ok(format!("http://127.0.0.1:{tunnel_port}"))
    }
}

/// 生成 own-model.json 内容（纯函数）。env 块注入 BASE_URL / 令牌 / 模型。
pub(super) fn deploy_config_json(base_url: &str, token: &str, model: &str) -> String {
    serde_json::to_string_pretty(&json!({
        "env": {
            "ANTHROPIC_BASE_URL": base_url,
            "ANTHROPIC_AUTH_TOKEN": token,
            "ANTHROPIC_MODEL": model,
        }
    }))
    .expect("序列化配置不应失败")
}

/// 服务账号名合法性（防 shell/setfacl 注入）：只许字母数字与 `_-`。
pub(super) fn valid_service_account(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 构建远端部署脚本（纯函数）。
///
/// - 配置经 **quoted heredoc** 原样写入（不展开、不注入）；
/// - 服务账号优先用 override，否则从 `/usr/local/bin/claude` 的 `SVC_USER` 探测；
/// - `chmod 600` 后 `setfacl m::rw` 恢复 mask（否则 mask::--- 会把授权剥光，b278e73 教训）；
/// - alias 用 `sed -i` 删旧行再追加一行 → 幂等，不叠行；
/// - 全程不用 `exit`（helper 是常驻 shell，exit 会杀掉会话）。
pub(super) fn deploy_script(config_json: &str, svc_override: &str) -> String {
    format!(
        r#"CCB_HOME="$HOME"
CCB_DIR="$CCB_HOME/.claude-own"
CCB_FILE="$CCB_DIR/own-model.json"
if mkdir -p "$CCB_DIR" && cat > "$CCB_FILE" <<'CCB_JSON_EOF'
{config_json}
CCB_JSON_EOF
then
  chmod 600 "$CCB_FILE"
  CCB_SVC="{svc_override}"
  if [ -z "$CCB_SVC" ] && [ -r /usr/local/bin/claude ]; then
    CCB_SVC=$(sed -n 's/^SVC_USER="\([^"]*\)".*/\1/p' /usr/local/bin/claude | head -n1)
  fi
  if [ -n "$CCB_SVC" ] && command -v setfacl >/dev/null 2>&1; then
    setfacl -m "u:$CCB_SVC:r-x,m::rw" "$CCB_FILE" 2>/dev/null
  fi
  touch "$CCB_HOME/.bashrc"
  sed -i '/^alias claude-own=/d' "$CCB_HOME/.bashrc"
  printf '%s\n' "{ALIAS_LINE}" >> "$CCB_HOME/.bashrc"
  echo "CCB_DEPLOY_HOME=$CCB_HOME"
  echo "CCB_DEPLOY_FILE=$CCB_FILE"
  echo "CCB_DEPLOY_SVC=$CCB_SVC"
  echo "CCB_DEPLOY_OK=1"
else
  echo "CCB_DEPLOY_ERR=cannot_write_$CCB_FILE"
fi"#
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployResult {
    pub base_url: String,
    pub file: String,
    pub home: String,
    pub service_account: String,
    pub alias: String,
    pub config_json: String,
}

fn field(out: &str, key: &str) -> String {
    out.lines()
        .find_map(|l| l.strip_prefix(&format!("{key}=")))
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 把中转配置部署到所选 SSH 连接的远端用户家目录。
#[tauri::command]
pub async fn relay_deploy_config(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    service_account: Option<String>,
    model: Option<String>,
) -> Result<DeployResult, String> {
    let state = state.inner();
    let svc_override = service_account.unwrap_or_default();
    if !svc_override.is_empty() && !valid_service_account(&svc_override) {
        return Err("服务账号名只能含字母、数字、_、-。".into());
    }
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let (mode, lan_host, tunnel_port) = {
        let config = state.config.read().await;
        let mode = config.relay_listen_mode.clone();
        let lan_host = relay_listen_host(&config);
        let port = {
            let db = state.db.lock().await;
            get_config_value(&db, &format!("relay:{connection_id}"))
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
                .unwrap_or(0) as u16
        };
        (mode, lan_host, port)
    };
    let token = state.relay.token_value().await;
    if token.is_empty() {
        return Err("中转令牌为空，请先在中转页生成令牌。".into());
    }
    let base_url = deploy_base_url(&mode, &lan_host, tunnel_port)?;
    let config_json = deploy_config_json(&base_url, &token, &model);
    let script = deploy_script(&config_json, &svc_override);

    let link = SshLink::from_config(&*state.config.read().await, &connection_id)?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;

    let out = match run_via_helper(state, &link, &ssh_path, creds.clone(), script.clone()).await {
        Ok((out, 0)) => out,
        _ => {
            let mut args = ssh_base_args(&link, "-p");
            args.push(format!("{}@{}", link.conn.username, link.conn.host));
            args.push(script);
            spawn_capture_off_runtime(ssh_path, args, creds).await?
        }
    };
    if !out.contains("CCB_DEPLOY_OK=1") {
        return Err(format!("远端部署未完成：{}", out.trim()));
    }
    // 记录本次部署的地址与连接：主页据此检测「本机 IP 变了、远端还指旧地址」的漂移。
    {
        let db = state.db.lock().await;
        let _ = set_config_value(
            &db,
            LAST_DEPLOY_KEY,
            &serde_json::json!({ "url": base_url, "connectionId": connection_id }).to_string(),
        );
    }
    Ok(DeployResult {
        base_url,
        file: field(&out, "CCB_DEPLOY_FILE"),
        home: field(&out, "CCB_DEPLOY_HOME"),
        service_account: field(&out, "CCB_DEPLOY_SVC"),
        alias: ALIAS_LINE.to_string(),
        config_json,
    })
}

/// 上次成功部署的地址与连接（漂移检测用）。从未部署过返回 None。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastDeploy {
    pub url: String,
    pub connection_id: String,
}

#[tauri::command]
pub async fn relay_last_deploy(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<LastDeploy>, String> {
    let db = state.db.lock().await;
    Ok(get_config_value(&db, LAST_DEPLOY_KEY).and_then(|s| {
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        Some(LastDeploy {
            url: v.get("url")?.as_str()?.to_string(),
            connection_id: v.get("connectionId")?.as_str()?.to_string(),
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_follows_mode() {
        assert_eq!(
            deploy_base_url("direct", "10.203.5.54", 0).unwrap(),
            "http://10.203.5.54:4100"
        );
        assert_eq!(
            deploy_base_url("tunnel", "127.0.0.1", 37505).unwrap(),
            "http://127.0.0.1:37505"
        );
        // 反例：隧道未分配端口必须报错，不静默给连不上的地址。
        assert!(deploy_base_url("tunnel", "127.0.0.1", 0).is_err());
    }

    #[test]
    fn config_json_has_env_block() {
        let s = deploy_config_json("http://1.2.3.4:4100", "rly_x", "claude-sonnet-5-5");
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "http://1.2.3.4:4100");
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "rly_x");
        assert_eq!(v["env"]["ANTHROPIC_MODEL"], "claude-sonnet-5-5");
    }

    #[test]
    fn service_account_validation_rejects_injection() {
        assert!(valid_service_account("claude-svc"));
        assert!(valid_service_account("svc_2"));
        assert!(!valid_service_account(""));
        assert!(!valid_service_account("a; rm -rf /"));
        assert!(!valid_service_account("a\"b"));
        assert!(!valid_service_account("a b"));
    }

    #[test]
    fn script_is_user_agnostic_and_idempotent() {
        let s = deploy_script("{}", "");
        // 不写死用户名/家目录：用 $HOME 与 tilde。
        assert!(s.contains("$HOME"), "必须用动态家目录");
        assert!(
            s.contains("~/.claude-own/own-model.json"),
            "alias 必须 tilde 可移植"
        );
        assert!(!s.contains("lizuliang"), "不得写死用户名");
        assert!(!s.contains("/home/"), "不得写死绝对家目录");
        // 幂等：先删旧 alias 行再追加。
        assert!(s.contains("sed -i '/^alias claude-own=/d'"));
        // 不用 exit（常驻 helper shell）。
        assert!(!s
            .lines()
            .any(|l| l.trim() == "exit" || l.trim().starts_with("exit ")));
        // mask 恢复（b278e73 教训）。
        assert!(s.contains("m::rw"));
    }

    #[test]
    fn script_embeds_config_verbatim_and_override_svc() {
        let cfg = deploy_config_json("http://h:4100", "rly_tok", "m");
        let s = deploy_script(&cfg, "claude-svc");
        assert!(s.contains(&cfg), "配置须原样嵌入");
        assert!(s.contains("CCB_SVC=\"claude-svc\""), "override 须生效");
        assert!(s.contains("<<'CCB_JSON_EOF'"), "heredoc 须 quoted 防展开");
    }
}
