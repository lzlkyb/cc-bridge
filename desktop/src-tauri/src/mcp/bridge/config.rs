//! 外挂 MCP server 的配置结构与校验。
//!
//! 🔴 这里只管“一个外挂 server 长什么样”，不管它存在哪儿（SQLite 的 config 表，
//! 接入在后面的阶段）。分开是为了让 `manifest` / `spawn` 现在就能用上它。

use serde::{Deserialize, Serialize};

/// 一个外挂 MCP server 的完整描述。
///
/// 字段有意跟 Claude Code / Cursor 的 `mcpServers` 对齐（`command` / `args` / `env` / `type`），
/// 这样从用户已有配置导入时是 1:1 映射，不用猜。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalMcpServer {
    pub name: String,
    /// `"stdio"`（第一步唯一支持）/ `"http"` / `"sse"`。
    ///
    /// 现在就放进来而不是将来再加：否则支持 HTTP 型时要做一次配置迁移。
    #[serde(default = "default_transport")]
    pub transport: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 不用 `HashMap`：要保序（指纹靠它算）且序列化后可读。
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// 不填则继承 cc-bridge 进程的工作目录（决策 3）。
    ///
    /// ⚠ 那个目录**不在白名单控制下**，所以设置页在此项为空时必须把实际生效的
    /// 目录显示出来（方案 S0：让用户看得见自己交出去的是什么）。
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    /// 允许远程在 `mcp_proxy` 里指定工作目录（限白名单根目录内）。**默认 false**。
    ///
    /// 🔴 这是**能力边界的扩大**，不是纯便利开关：关着时 cwd 由本机管理员定死，
    /// 开了之后由远程在白名单里挑。对于**不接受路径参数、只从 cwd 解析**的 server，
    /// 这道边界原本是硬的——不能拿“args 本来就不受控”搪塞过去。
    ///
    /// **不进指纹**：它不影响进程怎么启动，也不会改变工具清单。
    #[serde(default)]
    pub allow_remote_cwd: bool,
}

fn default_transport() -> String {
    "stdio".to_string()
}

/// server 名的合法字符。它会进入工具参数与（将来的）扁平化工具名，
/// 所以口径开小一点，先不允许大写与点。
const NAME_MAX: usize = 32;

impl ExternalMcpServer {
    /// 名字校验：`[a-z0-9_-]{1,32}`。
    pub fn validate_name(name: &str) -> Result<(), String> {
        if name.is_empty() || name.len() > NAME_MAX {
            return Err(format!(
                "server 名长度需在 1..={NAME_MAX} 之间（当前：{}）",
                name.len()
            ));
        }
        if let Some(bad) = name
            .chars()
            .find(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-'))
        {
            return Err(format!(
                "server 名只允许小写字母 / 数字 / 下划线 / 连字符，出现了 `{bad}`"
            ));
        }
        Ok(())
    }

    pub fn is_stdio(&self) -> bool {
        self.transport == "stdio"
    }

    /// 指纹：决定已缓存的工具清单还算不算数。
    ///
    /// **不做哈希，直接存规范化串**。理由：
    /// - 它本来就短（几百字节），没必要压；
    /// - 没有碰撞可担心；
    /// - 出问题时能直接看出来“到底是哪一项变了”，而一串哈希什么也说不了；
    /// - `DefaultHasher` 官方明确说不保证跨版本稳定，存进库里会在升级 Rust 后集体失效。
    ///
    /// 🔴 **只取 env 的键名，不取值**（S7）——指纹会落盘，值里是 API key。
    /// 代价是改了某个 key 的值不会触发刷新——而那本来也不应该改变工具清单。
    ///
    /// 已知局限：不含**解析后的可执行文件路径**。用户把工具升级/重装到别处时，
    /// 指纹不变、清单不会自动失效，得手动点刷新。把路径算进来就要让指纹计算依赖
    /// 文件系统，那会让它从纯函数变成会失败的操作，不值。
    pub fn fingerprint(&self) -> String {
        let mut env_keys: Vec<&str> = self.env.iter().map(|(k, _)| k.as_str()).collect();
        env_keys.sort_unstable();
        // \u{1f} 是 ASCII 的单元分隔符，不可能出现在命令行里，避免拼接歧义
        // （否则 args=["a b"] 与 args=["a","b"] 会算出同一个指纹）。
        const SEP: char = '\u{1f}';
        format!(
            "v1{SEP}{}{SEP}{}{SEP}{}{SEP}{}{SEP}{}",
            self.transport,
            self.command,
            self.args.join(&SEP.to_string()),
            env_keys.join(","),
            self.cwd.as_deref().unwrap_or("")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ExternalMcpServer {
        ExternalMcpServer {
            name: "codegraph".into(),
            transport: "stdio".into(),
            command: "codegraph".into(),
            args: vec!["serve".into(), "--mcp".into()],
            env: vec![],
            cwd: None,
            enabled: false,
            allow_remote_cwd: false,
        }
    }

    #[test]
    fn name_rules() {
        assert!(ExternalMcpServer::validate_name("codegraph").is_ok());
        assert!(ExternalMcpServer::validate_name("paper_search-1").is_ok());
        assert!(ExternalMcpServer::validate_name("").is_err());
        assert!(
            ExternalMcpServer::validate_name("Codegraph").is_err(),
            "不允许大写"
        );
        assert!(ExternalMcpServer::validate_name("a.b").is_err(), "不允许点");
        assert!(ExternalMcpServer::validate_name(&"x".repeat(33)).is_err());
    }

    /// B10：改 args → 指纹变。
    #[test]
    fn fingerprint_changes_with_args() {
        let a = spec();
        let mut b = spec();
        b.args.push("--no-watch".into());
        assert_ne!(a.fingerprint(), b.fingerprint());
    }

    /// 拼接不能歧义：`["a b"]` 与 `["a","b"]` 必须算出不同指纹。
    #[test]
    fn fingerprint_is_unambiguous_across_arg_splits() {
        let mut a = spec();
        a.args = vec!["a b".into()];
        let mut b = spec();
        b.args = vec!["a".into(), "b".into()];
        assert_ne!(a.fingerprint(), b.fingerprint());
    }

    /// env **键名**参与指纹，顺序无关；**值不参与也不得出现**。
    #[test]
    fn fingerprint_uses_env_keys_only() {
        let mut a = spec();
        a.env = vec![
            ("B_KEY".into(), "secret-1".into()),
            ("A_KEY".into(), "secret-2".into()),
        ];
        let mut b = spec();
        b.env = vec![
            ("A_KEY".into(), "完全不同的值".into()),
            ("B_KEY".into(), "也不同".into()),
        ];
        assert_eq!(
            a.fingerprint(),
            b.fingerprint(),
            "只改值 / 只换顺序不应该让清单失效"
        );
        let fp = a.fingerprint();
        assert!(!fp.contains("secret-1"), "密钥值泄漏进指纹了：{fp}");
        assert!(fp.contains("A_KEY") && fp.contains("B_KEY"));

        // 多一个键则必须变。
        let mut c = a.clone();
        c.env.push(("C_KEY".into(), "v".into()));
        assert_ne!(a.fingerprint(), c.fingerprint());
    }

    #[test]
    fn fingerprint_changes_with_cwd() {
        let a = spec();
        let mut b = spec();
        b.cwd = Some("D:/proj".into());
        assert_ne!(a.fingerprint(), b.fingerprint());
    }
}
