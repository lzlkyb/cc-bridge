//! 从用户**已有的** MCP 客户端配置里导入。
//!
//! 用户手上多半已经配好了 MCP（本机 `~/.claude.json` 里就有 3 个）。让他到设置页
//! 重新手输 command / args / env 是很差的体验，也容易输错。字段几乎 1:1 对应，不用猜。
//!
//! 🔴 三条硬规矩：
//! 1. **默认全部不启用**（S2）。扫到就开是灾难——本机扫到的第一个 `filesystem`
//!    根目录就是 `D:`，桥出去等于把整个 D 盘交给远程（白名单完全绕过）。
//! 2. **cc-bridge 自己必须被认出来并排除**（S8），否则就是自己桥自己。
//! 3. **env 只给键名**（S7）。
//!
//! 解析部分是**纯函数**（只吃 `Value`），所以不碰文件系统就能完整单测。

use std::path::PathBuf;

use serde_json::{json, Value};

use super::config::ExternalMcpServer;
use super::spawn;

/// 一个候选项的可用性。
#[derive(Debug, Clone, PartialEq)]
pub enum CandidateStatus {
    /// 可以导入（仍需用户逐个勾选）。
    Importable,
    /// 设置页里已经有一模一样的一条了。列出来但置灰。
    AlreadyImported,
    /// 列出来但不能用，带原因。**不静默丢掉**——直接不显示会让用户以为扫漏了。
    Unavailable(String),
}

impl CandidateStatus {
    /// 给用户看的原因。
    ///
    /// 导入被拒时原先直接拿 `{:?}` 往外抛，用户会在界面上看到
    /// `Unavailable("…")` 这种调试串。
    pub fn reason(&self) -> String {
        match self {
            Self::Importable => "可导入".into(),
            Self::AlreadyImported => "已导入（配置相同）".into(),
            Self::Unavailable(r) => r.clone(),
        }
    }
}

/// 一个待导入项。
pub struct ImportCandidate {
    pub spec: ExternalMcpServer,
    /// 来源描述，展给用户看（如 `~/.claude.json` 或 `~/.claude.json（项目 myapp）`）。
    pub source: String,
    pub status: CandidateStatus,
}

/// 🔴 手写 Debug：`ExternalMcpServer` 的 derive 会把 **env 值**一并打印出来，
/// 而那里面是 API key（本机 `paper_search_mcp` 就带 `SEMANTIC_SCHOLAR_API_KEY`）。
/// 一行 `log::debug!("{cand:?}")` 就足以把密钥写进日志。
impl std::fmt::Debug for ImportCandidate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportCandidate")
            .field("name", &self.spec.name)
            .field("command", &self.spec.command)
            .field("args", &self.spec.args)
            .field("envKeys", &self.env_keys())
            .field("source", &self.source)
            .field("status", &self.status)
            .finish()
    }
}

impl ImportCandidate {
    /// 只给键名（S7）。
    pub fn env_keys(&self) -> Vec<&str> {
        self.spec.env.iter().map(|(k, _)| k.as_str()).collect()
    }

    /// 给前端的预览。**不含任何 env 值**。
    ///
    /// `command` 与 `args` 原样展示（S0）：用户得看得见自己要交出去的是 `D:`
    /// 还是某个子目录。不做智能解析（参数含义因 server 而异，解析就是写适配层）。
    pub fn to_preview(&self) -> Value {
        let (state, reason) = match &self.status {
            CandidateStatus::Importable => ("importable", Value::Null),
            CandidateStatus::AlreadyImported => ("already_imported", json!(self.status.reason())),
            CandidateStatus::Unavailable(r) => ("unavailable", json!(r)),
        };
        json!({
            "name": self.spec.name,
            "transport": self.spec.transport,
            "command": self.spec.command,
            "args": self.spec.args,
            "envKeys": self.env_keys(),
            "cwd": self.spec.cwd,
            "source": self.source,
            "state": state,
            "reason": reason,
        })
    }
}

/// 解析 Claude Code 的 `~/.claude.json`：顶层 `mcpServers` + `projects.*.mcpServers`。
///
/// 项目级的也含（决策 4）：本机目前只有全局的，但别的机器上有，漏扫比多扫更难排查。
pub fn parse_claude_code(root: &Value, source: &str) -> Vec<ImportCandidate> {
    let mut out = from_map(root.get("mcpServers"), source, None);
    if let Some(projects) = root.get("projects").and_then(|p| p.as_object()) {
        for (path, v) in projects {
            let label = PathBuf::from(path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            out.extend(from_map(v.get("mcpServers"), source, Some(&label)));
        }
    }
    out
}

/// Cursor / Claude Desktop 等：只有顶层 `mcpServers`。
pub fn parse_flat(root: &Value, source: &str) -> Vec<ImportCandidate> {
    from_map(root.get("mcpServers"), source, None)
}

fn from_map(map: Option<&Value>, source: &str, project: Option<&str>) -> Vec<ImportCandidate> {
    let Some(obj) = map.and_then(|m| m.as_object()) else {
        return vec![];
    };
    let mut out: Vec<ImportCandidate> = obj
        .iter()
        .map(|(name, v)| one(name, v, source, project))
        .collect();
    // 按名字排序：JSON 对象的遍历顺序不稳定，而 UI 列表不能每次打开都变序。
    out.sort_by(|a, b| a.spec.name.cmp(&b.spec.name));
    out
}

fn one(name: &str, v: &Value, source: &str, project: Option<&str>) -> ImportCandidate {
    let transport = v
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("stdio")
        .to_string();
    let command = v
        .get("command")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();
    let args = v
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .map(|x| x.as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut env: Vec<(String, String)> = v
        .get("env")
        .and_then(|e| e.as_object())
        .map(|o| {
            o.iter()
                .map(|(k, val)| (k.clone(), val.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default();
    env.sort_by(|a, b| a.0.cmp(&b.0)); // 保序，否则指纹会飘

    let source = match project {
        Some(p) => format!("{source}（项目 {p}）"),
        None => source.to_string(),
    };

    let spec = ExternalMcpServer {
        name: sanitize_name(name, project),
        transport,
        command,
        args,
        env,
        cwd: v.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string()),
        // 🔴 恒为 false（S2）。导入只负责把已有配置读出来展示，开不开由用户逐个决定。
        enabled: false,
        allow_remote_cwd: false,
    };

    let status = classify(&spec);
    ImportCandidate {
        spec,
        source,
        status,
    }
}

/// 把外部名字揉成合法的 server 名。项目级的带上项目后缀避免重名（决策 4）。
fn sanitize_name(raw: &str, project: Option<&str>) -> String {
    let base: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let name = match project {
        Some(p) => {
            let suffix: String = p
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                        c.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect();
            format!("{base}-{suffix}")
        }
        None => base,
    };
    name.chars().take(32).collect()
}

/// 可用性判定。**不碰文件系统**（自我识别在 `mark_self` 里做）。
fn classify(spec: &ExternalMcpServer) -> CandidateStatus {
    if spec.command.trim().is_empty() {
        return CandidateStatus::Unavailable(
            "这条配置没有 command（可能是基于 URL 的远程 server）。".into(),
        );
    }
    if !spec.is_stdio() {
        return CandidateStatus::Unavailable(format!(
            "类型是 `{}`，第一步只支持 stdio。",
            spec.transport
        ));
    }
    if ExternalMcpServer::validate_name(&spec.name).is_err() {
        return CandidateStatus::Unavailable("名字无法自动转成合法形式，请手动重命名。".into());
    }
    CandidateStatus::Importable
}

/// 🔴 S8：把指向 cc-bridge 自己的候选项标为不可用（**列出来但置灰**）。
///
/// 这一步要碰文件系统（解析 PATH + canonicalize），所以从解析里拆出来，
/// 让 `parse_*` 保持纯函数、能用 JSON 直接单测。
///
/// 判定靠路径不靠名字：名字是用户随便取的，既会误判也会漏判。
pub fn mark_self(cands: &mut [ImportCandidate]) {
    for c in cands.iter_mut() {
        if c.status != CandidateStatus::Importable {
            continue;
        }
        let Ok(p) = spawn::resolve_program(&c.spec.command) else {
            continue; // 命令不存在不在这里判，交给设置页展示
        };
        if spawn::is_self_executable(&p) {
            c.status = CandidateStatus::Unavailable(
                "这就是 cc-bridge 自己，无需也不能桥接（远程本来就直连着它）。".into(),
            );
        }
    }
}

/// 标记「已经导入过」的候选。
///
/// 判定是 **同名 + 同配置**，不是只看名字。只看名字会把「同名但配置不同」的
/// 另一个 server 静默吃掉——而那恰恰就是 [`resolve_names`] 改名逻辑存在的理由。
///
/// 刻意**不比**的两个字段：
/// - `enabled`：导入后一律关着（S2），用户把它开了不代表它变成了另一个 server。
///   比了的话，**一启用它就会重新冒出来当成可导入项**，恰好把这个修复抵消掉。
/// - `allow_remote_cwd`：本机管理员事后的决定，与「这是不是同一个 server」无关。
///
/// `env` 只比**键名**：值是密钥（预览里本来就不给，S7），且用户很可能在设置页改过。
pub fn mark_already_imported(cands: &mut [ImportCandidate], existing: &[ExternalMcpServer]) {
    for c in cands.iter_mut() {
        if c.status != CandidateStatus::Importable {
            continue;
        }
        if existing.iter().any(|e| same_server(e, &c.spec)) {
            c.status = CandidateStatus::AlreadyImported;
        }
    }
}

fn env_keys_sorted(s: &ExternalMcpServer) -> Vec<&str> {
    let mut k: Vec<&str> = s.env.iter().map(|(k, _)| k.as_str()).collect();
    k.sort_unstable();
    k
}

/// 「是同一个 server」的判定。不比哪些字段见 [`mark_already_imported`]。
fn same_server(a: &ExternalMcpServer, b: &ExternalMcpServer) -> bool {
    a.name == b.name
        && a.transport == b.transport
        && a.command == b.command
        && a.args == b.args
        && a.cwd == b.cwd
        && env_keys_sorted(a) == env_keys_sorted(b)
}

/// 同名去重：后来者加数字后缀，**不静默覆盖**。
///
/// 覆盖会让用户以为启用的是 A、实际启用的是 B——而两者的能力边界可能完全不同。
pub fn dedupe_names(cands: &mut [ImportCandidate]) {
    resolve_names(cands, &[]);
}

/// 同名去重，并额外避开 `reserved` 里已被占用的名字（设置页里**已有的** server）。
///
/// 返回被改名的 `(原名, 新名)`，供导入向导提示「已存在同名，导入为 xxx-2」。
/// 不提示的话，用户会以为自己导入的是那条已有的、或者以为覆盖掉了它。
pub fn resolve_names(cands: &mut [ImportCandidate], reserved: &[String]) -> Vec<(String, String)> {
    let mut seen: Vec<String> = reserved.to_vec();
    let mut renamed = Vec::new();
    for c in cands.iter_mut() {
        // 已导入的保持原名：它在列表里就是要让用户认出「这条我已经有了」，
        // 改成 xxx-2 反而对不上号。它的名字本来就在 `reserved` 里，不会挡到别人。
        if c.status == CandidateStatus::AlreadyImported {
            continue;
        }
        if !seen.contains(&c.spec.name) {
            seen.push(c.spec.name.clone());
            continue;
        }
        let from = c.spec.name.clone();
        for n in 2.. {
            let candidate = format!("{from}-{n}");
            if !seen.contains(&candidate) {
                c.spec.name = candidate.clone();
                seen.push(candidate.clone());
                renamed.push((from, candidate));
                break;
            }
        }
    }
    renamed
}

#[cfg(test)]
mod name_tests {
    use super::*;

    fn cand(name: &str) -> ImportCandidate {
        ImportCandidate {
            spec: ExternalMcpServer {
                name: name.into(),
                transport: "stdio".into(),
                command: "x".into(),
                args: vec![],
                env: vec![],
                cwd: None,
                enabled: false,
                allow_remote_cwd: false,
            },
            source: "t".into(),
            status: CandidateStatus::Importable,
        }
    }

    /// 跟**已有配置**重名时必须避让，否则导入会静默造出两个同名项——
    /// 而用户启用的到底是哪一个就说不清了。
    #[test]
    fn avoids_names_already_in_config() {
        let mut cands = vec![cand("codegraph"), cand("other")];
        let renamed = resolve_names(&mut cands, &["codegraph".to_string()]);
        assert_eq!(cands[0].spec.name, "codegraph-2");
        assert_eq!(cands[1].spec.name, "other");
        assert_eq!(
            renamed,
            vec![("codegraph".to_string(), "codegraph-2".to_string())]
        );
    }

    /// 候选之间重名，且避让后的名字不得再撞上 `reserved`。
    #[test]
    fn skips_over_reserved_when_deduping() {
        let mut cands = vec![cand("a"), cand("a"), cand("a")];
        resolve_names(&mut cands, &["a-2".to_string()]);
        assert_eq!(cands[0].spec.name, "a");
        // a-2 被已有配置占了，所以跳到 a-3 / a-4
        assert_eq!(cands[1].spec.name, "a-3");
        assert_eq!(cands[2].spec.name, "a-4");
    }

    /// 没重名时一个字都不能改，也不能报改名。
    #[test]
    fn leaves_unique_names_alone() {
        let mut cands = vec![cand("a"), cand("b")];
        assert!(resolve_names(&mut cands, &["c".to_string()]).is_empty());
        assert_eq!(cands[0].spec.name, "a");
        assert_eq!(cands[1].spec.name, "b");
    }

    fn server(name: &str, args: &[&str]) -> ExternalMcpServer {
        ExternalMcpServer {
            name: name.into(),
            transport: "stdio".into(),
            command: "x".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: vec![],
            cwd: None,
            enabled: false,
            allow_remote_cwd: false,
        }
    }

    /// 同名同配置 = 已导入；同名但参数不同 = 另一个 server，仍可导入。
    ///
    /// 后半句是重点：只按名字排重会把它静默吃掉。
    #[test]
    fn already_imported_needs_same_config() {
        let existing = vec![server("codegraph", &["serve", "--mcp"])];

        let mut same = vec![cand("codegraph")];
        same[0].spec.args = vec!["serve".into(), "--mcp".into()];
        mark_already_imported(&mut same, &existing);
        assert_eq!(same[0].status, CandidateStatus::AlreadyImported);

        let mut different = vec![cand("codegraph")];
        different[0].spec.args = vec!["serve".into(), "--http".into()];
        mark_already_imported(&mut different, &existing);
        assert_eq!(
            different[0].status,
            CandidateStatus::Importable,
            "同名但配置不同的是另一个 server，不能当成重复项吃掉"
        );
    }

    /// 用户把导入的 server 开启了，它仍然是同一条。
    ///
    /// 如果比了 `enabled` / `allow_remote_cwd`，一启用它就会重新冒出来当成可导入项——
    /// 恰好把本修复抵消掉。
    #[test]
    fn enabled_and_remote_cwd_do_not_affect_identity() {
        let mut e = server("codegraph", &[]);
        e.enabled = true;
        e.allow_remote_cwd = true;
        let mut cands = vec![cand("codegraph")];
        mark_already_imported(&mut cands, &[e]);
        assert_eq!(cands[0].status, CandidateStatus::AlreadyImported);
    }

    /// 已导入的不能被改成 xxx-2，否则用户在列表里对不上号。
    #[test]
    fn already_imported_keeps_its_name() {
        let existing = vec![server("codegraph", &[])];
        let mut cands = vec![cand("codegraph")];
        mark_already_imported(&mut cands, &existing);
        let renamed = resolve_names(&mut cands, &["codegraph".to_string()]);
        assert_eq!(cands[0].spec.name, "codegraph");
        assert!(renamed.is_empty(), "已导入的不应该产生改名提示");
    }

    /// 不可用的（如 cc-bridge 自己）不能被“已导入”盖掉原因。
    #[test]
    fn does_not_overwrite_an_existing_reason() {
        let mut cands = vec![cand("codegraph")];
        cands[0].status = CandidateStatus::Unavailable("这就是 cc-bridge 自己".into());
        mark_already_imported(&mut cands, &[server("codegraph", &[])]);
        assert!(matches!(cands[0].status, CandidateStatus::Unavailable(_)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一份跟本机 `~/.claude.json` **同形状**的样本：三种完全不同的启动形态。
    fn sample() -> Value {
        serde_json::json!({
            "mcpServers": {
                "filesystem": {
                    "type": "stdio",
                    "command": "cmd",
                    "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "D:"]
                },
                "codegraph": { "command": "codegraph", "args": ["serve", "--mcp"] },
                "paper_search_mcp": {
                    "command": "python.exe",
                    "args": ["-m", "paper_search_mcp.server"],
                    "env": { "SEMANTIC_SCHOLAR_API_KEY": "sk-live-DO-NOT-LEAK" }
                }
            }
        })
    }

    /// B11：三种形态都能解出来，且**全部 `enabled=false`**。
    #[test]
    fn parses_all_three_shapes_and_never_auto_enables() {
        let c = parse_claude_code(&sample(), "~/.claude.json");
        assert_eq!(c.len(), 3);
        // 排过序，UI 列表不能每次打开都变序。
        let names: Vec<&str> = c.iter().map(|x| x.spec.name.as_str()).collect();
        assert_eq!(names, vec!["codegraph", "filesystem", "paper_search_mcp"]);

        for x in &c {
            assert!(
                !x.spec.enabled,
                "{} 被自动启用了——扫到就开是灾难",
                x.spec.name
            );
            assert_eq!(x.status, CandidateStatus::Importable);
        }

        // 命令形状原样保留，**不拆** `cmd /c npx …`。
        let fs = &c[1];
        assert_eq!(fs.spec.command, "cmd");
        assert_eq!(fs.spec.args[0], "/c");
        assert_eq!(
            fs.spec.args.last().map(|s| s.as_str()),
            Some("D:"),
            "根目录参数必须原样保留并展给用户看（S0）"
        );

        // 缺省 type 时当 stdio。
        assert_eq!(c[0].spec.transport, "stdio");
    }

    /// B12：env 值**不得**出现在任何输出里（预览 / Debug 都算）。
    #[test]
    fn env_values_never_appear_in_any_output() {
        let c = parse_claude_code(&sample(), "~/.claude.json");
        let paper = c
            .iter()
            .find(|x| x.spec.name == "paper_search_mcp")
            .expect("应解出来");

        // 值本身必须被保留（否则导入后启动会缺环境变量）……
        assert_eq!(paper.spec.env[0].1, "sk-live-DO-NOT-LEAK");
        // ……但不得流到任何展示路径上。
        let preview = paper.to_preview().to_string();
        assert!(!preview.contains("sk-live"), "预览里泄了密钥：{preview}");
        assert!(preview.contains("SEMANTIC_SCHOLAR_API_KEY"), "键名要给");

        // Debug 也不行——一行 log::debug! 就能把密钥写进日志。
        let dbg = format!("{paper:?}");
        assert!(!dbg.contains("sk-live"), "Debug 里泄了密钥：{dbg}");
    }

    /// 非 stdio 列出但置灰，**不静默丢掉**。
    #[test]
    fn http_type_is_listed_but_unavailable() {
        let v = serde_json::json!({
            "mcpServers": { "remote": { "type": "http", "url": "https://x/mcp" } }
        });
        let c = parse_flat(&v, "~/.cursor/mcp.json");
        assert_eq!(c.len(), 1, "不能丢掉，否则用户以为扫漏了");
        assert!(matches!(c[0].status, CandidateStatus::Unavailable(_)));
    }

    /// 项目级的带项目后缀，来源也要标明（决策 4）。
    #[test]
    fn project_scoped_servers_get_suffix_and_source_label() {
        let v = serde_json::json!({
            "projects": {
                "D:\\work\\myapp": { "mcpServers": { "filesystem": { "command": "npx" } } }
            }
        });
        let c = parse_claude_code(&v, "~/.claude.json");
        assert_eq!(c[0].spec.name, "filesystem-myapp");
        assert!(
            c[0].source.contains("myapp"),
            "来源要标明是哪个项目：{}",
            c[0].source
        );
    }

    /// 同名不能静默覆盖。
    #[test]
    fn duplicate_names_are_suffixed_not_overwritten() {
        let mut c = parse_flat(
            &serde_json::json!({ "mcpServers": { "fs": { "command": "a" } } }),
            "A",
        );
        c.extend(parse_flat(
            &serde_json::json!({ "mcpServers": { "fs": { "command": "b" } } }),
            "B",
        ));
        dedupe_names(&mut c);
        assert_eq!(c[0].spec.name, "fs");
        assert_eq!(c[1].spec.name, "fs-2");
        // 两条都还在，内容没丢。
        assert_eq!(c[0].spec.command, "a");
        assert_eq!(c[1].spec.command, "b");
    }

    /// 大写 / 点 / 空格都要揉成合法名。
    #[test]
    fn names_are_sanitized() {
        let v = serde_json::json!({ "mcpServers": { "My Server.v2": { "command": "x" } } });
        let c = parse_flat(&v, "s");
        assert_eq!(c[0].spec.name, "my-server-v2");
        assert_eq!(c[0].status, CandidateStatus::Importable);
    }

    /// 只有 url 没有 command 的（旧式远程配置）→ 列出但不可用。
    #[test]
    fn entry_without_command_is_unavailable() {
        let v = serde_json::json!({ "mcpServers": { "x": { "url": "https://y" } } });
        let c = parse_flat(&v, "s");
        assert!(matches!(c[0].status, CandidateStatus::Unavailable(_)));
    }

    /// 真机校验：拿本机**真实的** `~/.claude.json` 跑一遍解析器。
    ///
    /// 标 `#[ignore]`：它依赖开发机装了什么，CI 上没这个文件。手动跑：
    /// `cargo test --no-default-features parses_real_claude_json -- --ignored --nocapture`
    ///
    /// 样本测试只能证明我写的形状能解，证明不了**真文件**的形状跟我想的一样。
    /// 输出只用 `to_preview()`，所以不会把密钥刷到终端上。
    #[test]
    #[ignore]
    fn parses_real_claude_json_on_this_machine() {
        let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
        else {
            println!("（拿不到家目录，跳过）");
            return;
        };
        let path = PathBuf::from(home).join(".claude.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            println!("（{} 不存在，跳过）", path.display());
            return;
        };
        let v: Value = serde_json::from_str(&raw).expect("真文件应是合法 JSON");

        let mut c = parse_claude_code(&v, "~/.claude.json");
        mark_self(&mut c);
        dedupe_names(&mut c);

        println!("解出 {} 条：", c.len());
        for x in &c {
            println!("  {}", x.to_preview());
            assert!(!x.spec.enabled, "任何情况下都不得自动启用");
        }
    }

    /// 🔴 S8：command 指向 cc-bridge 自己 → 置灰，且**名字不参与判定**。
    #[test]
    fn self_reference_is_marked_unavailable_by_path_not_name() {
        let me = std::env::current_exe().expect("current_exe");
        let v = serde_json::json!({
            "mcpServers": {
                // 名字毫不相干，但指向自身 → 必须被拦
                "totally-unrelated": { "command": me.to_string_lossy() },
                // 名字叫 cc-bridge，但指向别的东西 → 不能误拦
                "cc-bridge": { "command": "cmd" }
            }
        });
        let mut c = parse_flat(&v, "~/.claude.json");
        mark_self(&mut c);

        let mine = c
            .iter()
            .find(|x| x.spec.name == "totally-unrelated")
            .unwrap();
        assert!(
            matches!(mine.status, CandidateStatus::Unavailable(_)),
            "指向自身的必须被拦，否则就是自己桥自己"
        );
        let decoy = c.iter().find(|x| x.spec.name == "cc-bridge").unwrap();
        assert_eq!(
            decoy.status,
            CandidateStatus::Importable,
            "只是名字叫 cc-bridge 不能被误拦"
        );
    }
}
