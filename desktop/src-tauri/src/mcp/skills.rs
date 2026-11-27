//! MCP Skills 扩展（SEP-2640，扩展 ID `io.modelcontextprotocol/skills`）的服务端。
//!
//! 把「怎么高效地用 cc-bridge 改文件并验证」这类经验，作为技能随服务器一起发给接入的模型。
//! 技能文本放在 `desktop/src-tauri/skills/<name>/SKILL.md`（唯一来源），
//! 编译期 `include_str!` 进二进制；摘要与大小在首次使用时算一次。
//!
//! ## 安全边界（刻意收窄）
//! - **绝不读磁盘**：`resources/read` 只在编译期写死的目录里按 URI **整串精确匹配**，
//!   没有路径解析，所以 `file://`、绝对路径、`..`、未知技能天然都是 `-32602`。
//! - `resources/list` / `resources/templates/list` 只回**空列表**：声明 `resources` 能力后，
//!   客户端可能会调它们，回 -32601 会被当成服务器异常；规范允许空列表
//!   （技能靠 URI 直读，不依赖枚举）。不做 `resources/directory/read`（`directoryRead` 不声明），
//!   不转发第三方 server 的技能。
//! - 只在现代协议的 `server/discover` 里声明；`initialize`（老协议）与 SSE 不声明。
//!
//! ## 现状
//! 2026-11-27 真机实测：Claude Code 目前**没有**声明 skills 扩展，所以默认的
//! instructions 与改动前逐字相同，只有声明了扩展的客户端才会多一行指向技能的提示。
//! 本模块在没有客户端声明时处于休眠，不影响任何现有行为。
//!
//! 应急关闭：环境变量 `CC_BRIDGE_SKILLS=0`（或 `false` / `off`）。

use std::sync::OnceLock;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// 扩展 ID（规范固定字符串，勿改）。
pub const EXT_SKILLS: &str = "io.modelcontextprotocol/skills";
const ERR_INVALID_PARAMS: i64 = -32602;
/// 规范：每个技能最多 512 个资源、合计 16 MiB。我们只有几个小文件，仅作启动自检。
#[cfg(test)]
const MAX_RESOURCES_PER_SKILL: usize = 512;
#[cfg(test)]
const MAX_BYTES_PER_SKILL: usize = 16 * 1024 * 1024;

/// 列表缓存提示：技能文本随二进制发布，进程内不会变；客户端缓存 1 小时即可。
const LIST_TTL_MS: u64 = 3_600_000;

/// 编译期写死的技能清单：`(技能路径, 文件相对路径, 文本)`。
/// 新增技能只需在这里加一行并放好文件；`catalog()` 的自检测试会核对 name 与路径一致。
/// 同一技能的 `SKILL.md` 必须排在它的其他文件前面（`catalog()` 依赖这个顺序建条目）。
const SKILL_FILES: &[(&str, &str, &str)] = &[
    (
        "local-edit-verify",
        "SKILL.md",
        include_str!("../../skills/local-edit-verify/SKILL.md"),
    ),
    (
        "local-edit-verify",
        "references/pitfalls.md",
        include_str!("../../skills/local-edit-verify/references/pitfalls.md"),
    ),
];

/// 指向第一份技能的提示行：只追加给声明了 skills 扩展的客户端。
pub const INSTRUCTIONS_POINTER: &str =
    "\n\n改文件并验证时的省往返用法见技能 skill://local-edit-verify/SKILL.md";

/// 总开关：默认开；`CC_BRIDGE_SKILLS` 设为 `0` / `false` / `off` 时关闭。
pub fn enabled() -> bool {
    !crate::mcp::tasks::disabled_by(std::env::var("CC_BRIDGE_SKILLS").ok().as_deref())
}

/// 这个请求是否声明了 skills 扩展（决定要不要追加 instructions 提示行）。
pub fn client_declares(body: &Value) -> bool {
    crate::mcp::tasks::client_declares(body, EXT_SKILLS)
}

/// `server/discover` 的 `capabilities` 里要并入的部分：`resources` 能力 + skills 扩展。
/// 规范：声明 skills 扩展的服务器必须同时声明 `resources` 能力。
pub fn merge_capabilities(caps: &mut Value) {
    if !enabled() {
        return;
    }
    caps["resources"] = json!({});
    if caps.get("extensions").is_none() {
        caps["extensions"] = json!({});
    }
    caps["extensions"][EXT_SKILLS] = json!({});
}

/// 一个技能的一个文件（含摘要与大小）。
struct SkillFile {
    uri: String,
    text: &'static str,
    digest: String,
    size: usize,
}

struct Skill {
    /// `SKILL.md` 的 URI（也是技能的标识）。
    uri: String,
    frontmatter: Value,
    files: Vec<SkillFile>,
}

impl Skill {
    /// 规范的技能条目：`skills/list` 的元素与 `skills/get` 的 `skill` 同形。
    fn entry(&self) -> Value {
        let resources: Vec<Value> = self
            .files
            .iter()
            .map(|f| json!({ "uri": f.uri, "digest": f.digest, "size": f.size }))
            .collect();
        json!({
            "uri": self.uri,
            "frontmatter": self.frontmatter,
            "resources": resources,
        })
    }
}

fn sha256_digest(bytes: &[u8]) -> String {
    let hex: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

/// 把 `SKILL.md` 开头的 YAML frontmatter 渲染成 JSON 对象。
///
/// 只支持我们自己写的最简形态（单行 `key: value`，值可带引号）——技能文本是编译期常量，
/// 不处理任意 YAML。解析不出 `name` / `description` 时返回 `None`，由自检测试兜住。
fn parse_frontmatter(text: &str) -> Option<Value> {
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut map = Map::new();
    for line in lines {
        if line.trim_end() == "---" {
            return (map.contains_key("name") && map.contains_key("description"))
                .then_some(Value::Object(map));
        }
        let (k, v) = line.split_once(':')?;
        let v = v.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .unwrap_or(v);
        map.insert(k.trim().to_string(), json!(v));
    }
    None
}

/// 技能目录：首次使用时按 `SKILL_FILES` 构建一次（摘要、大小、frontmatter）。
fn catalog() -> &'static [Skill] {
    static CATALOG: OnceLock<Vec<Skill>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let mut skills: Vec<Skill> = Vec::new();
        for (path, rel, text) in SKILL_FILES {
            let file = SkillFile {
                uri: format!("skill://{path}/{rel}"),
                text,
                digest: sha256_digest(text.as_bytes()),
                size: text.len(),
            };
            if *rel == "SKILL.md" {
                let Some(frontmatter) = parse_frontmatter(text) else {
                    // 编译期常量解析失败属于开发期错误：跳过该技能并留日志，测试会失败。
                    log::error!("技能 {path} 的 frontmatter 无法解析，已跳过");
                    continue;
                };
                skills.push(Skill {
                    uri: file.uri.clone(),
                    frontmatter,
                    files: vec![file],
                });
            } else if let Some(s) = skills
                .iter_mut()
                .find(|s| s.uri == format!("skill://{path}/SKILL.md"))
            {
                s.files.push(file);
            }
        }
        skills
    })
}

fn rpc_error(id: Option<&Value>, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok(id: Option<&Value>, mut result: Value) -> Value {
    result["resultType"] = json!("complete");
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 处理 `skills/list` / `skills/get` / `resources/read`，以及两个空列表方法；其它方法返回 `None`。
/// 调用方先判断 [`enabled`]。
pub fn handle_method(method: &str, body: &Value) -> Option<Value> {
    let id = body.get("id");
    let uri = body.pointer("/params/uri").and_then(Value::as_str);
    Some(match method {
        // 目录很小，一页放完，不做分页（规范允许，列表是否完整由 skills/get 兜底）。
        "skills/list" => ok(
            id,
            json!({
                "skills": catalog().iter().map(Skill::entry).collect::<Vec<_>>(),
                "ttlMs": LIST_TTL_MS,
                "cacheScope": "private",
            }),
        ),
        "skills/get" => {
            let Some(uri) = uri else {
                return Some(rpc_error(
                    id,
                    ERR_INVALID_PARAMS,
                    "Invalid params: uri is required",
                ));
            };
            // 规范：`params.uri` 必须是某个技能的 SKILL.md；其余一律 -32602。
            match catalog().iter().find(|s| s.uri == uri) {
                Some(s) => ok(id, json!({ "skill": s.entry() })),
                None => rpc_error(id, ERR_INVALID_PARAMS, "Unknown skill"),
            }
        }
        "resources/read" => {
            let Some(uri) = uri else {
                return Some(rpc_error(
                    id,
                    ERR_INVALID_PARAMS,
                    "Invalid params: uri is required",
                ));
            };
            // 整串精确匹配编译期目录，不解析路径、不碰磁盘。
            let hit = catalog()
                .iter()
                .flat_map(|s| s.files.iter())
                .find(|f| f.uri == uri);
            match hit {
                Some(f) => ok(
                    id,
                    json!({
                        "contents": [{
                            "uri": f.uri,
                            "mimeType": "text/markdown",
                            "text": f.text,
                        }],
                        "ttlMs": LIST_TTL_MS,
                        "cacheScope": "private",
                    }),
                ),
                None => rpc_error(id, ERR_INVALID_PARAMS, "Unknown resource"),
            }
        }
        // 声明了 `resources` 能力，就不能对列表请求回 Method not found；空列表合规。
        "resources/list" => ok(
            id,
            json!({ "resources": [], "ttlMs": LIST_TTL_MS, "cacheScope": "private" }),
        ),
        "resources/templates/list" => ok(
            id,
            json!({ "resourceTemplates": [], "ttlMs": LIST_TTL_MS, "cacheScope": "private" }),
        ),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &str, params: Value) -> Value {
        handle_method(method, &json!({ "id": 7, "params": params })).expect("应处理该方法")
    }

    const SKILL_URI: &str = "skill://local-edit-verify/SKILL.md";

    #[test]
    fn catalog_is_self_consistent() {
        // SKILL_FILES 里每个技能都必须解析成功（否则 catalog 会静默跳过它）。
        let expected = SKILL_FILES
            .iter()
            .filter(|(_, r, _)| *r == "SKILL.md")
            .count();
        assert_eq!(catalog().len(), expected, "有技能的 frontmatter 解析失败");
        for s in catalog() {
            // 规范：uri 的最后一个路径段必须等于 frontmatter.name。
            let path = s.uri.strip_prefix("skill://").unwrap();
            let skill_path = path.strip_suffix("/SKILL.md").unwrap();
            assert_eq!(
                skill_path.rsplit('/').next().unwrap(),
                s.frontmatter["name"].as_str().unwrap()
            );
            assert!(s.frontmatter["description"]
                .as_str()
                .is_some_and(|d| !d.is_empty()));
            // resources 必须包含 SKILL.md 自身，且不超规范限额。
            assert!(s.files.iter().any(|f| f.uri == s.uri));
            assert!(s.files.len() <= MAX_RESOURCES_PER_SKILL);
            assert!(s.files.iter().map(|f| f.size).sum::<usize>() <= MAX_BYTES_PER_SKILL);
        }
    }

    #[test]
    fn list_and_get_agree_and_digest_matches_bytes() {
        let list = call("skills/list", json!({}));
        assert_eq!(list["result"]["resultType"], json!("complete"));
        let entry = &list["result"]["skills"][0];
        assert_eq!(entry["uri"], json!(SKILL_URI));

        let got = call("skills/get", json!({ "uri": SKILL_URI }));
        assert_eq!(got["result"]["skill"], *entry, "list 与 get 的条目必须一致");

        // 摘要必须等于 resources/read 真实返回字节的 sha256，大小必须等于字节数。
        let read = call("resources/read", json!({ "uri": SKILL_URI }));
        let text = read["result"]["contents"][0]["text"].as_str().unwrap();
        let res = &entry["resources"][0];
        assert_eq!(res["digest"], json!(sha256_digest(text.as_bytes())));
        assert_eq!(res["size"], json!(text.len()));
        assert!(res["digest"].as_str().unwrap().starts_with("sha256:"));
        assert_eq!(res["digest"].as_str().unwrap().len(), "sha256:".len() + 64);
        // frontmatter 与正文开头一致（客户端会逐字段比对）。
        assert_eq!(entry["frontmatter"]["name"], json!("local-edit-verify"));
        assert!(
            text.starts_with("---\nname: local-edit-verify\n")
                || text.starts_with("---\r\nname: local-edit-verify\r\n")
        );
        assert_eq!(
            read["result"]["contents"][0]["mimeType"],
            json!("text/markdown")
        );
    }

    /// 清单里的每一个文件都能读到，且摘要、大小与真实字节一致；
    /// SKILL.md 里写的相对引用确实指向一个已发布的文件（否则模型会去读一个不存在的 URI）。
    #[test]
    fn every_listed_file_is_readable_and_verified() {
        let list = call("skills/list", json!({}));
        let resources = list["result"]["skills"][0]["resources"].as_array().unwrap();
        assert!(resources.len() >= 2, "应包含 SKILL.md 和参考文件");
        assert_eq!(resources[0]["uri"], json!(SKILL_URI), "SKILL.md 必须排第一");
        for r in resources {
            let uri = r["uri"].as_str().unwrap();
            let read = call("resources/read", json!({ "uri": uri }));
            let text = read["result"]["contents"][0]["text"].as_str().unwrap();
            assert_eq!(r["digest"], json!(sha256_digest(text.as_bytes())), "{uri}");
            assert_eq!(r["size"], json!(text.len()), "{uri}");
        }
        // 主文件里引用的参考文件必须真实存在（相对于技能根目录解析）。
        let skill_md = call("resources/read", json!({ "uri": SKILL_URI }));
        let md = skill_md["result"]["contents"][0]["text"].as_str().unwrap();
        assert!(md.contains("references/pitfalls.md"));
        assert!(resources
            .iter()
            .any(|r| r["uri"] == json!("skill://local-edit-verify/references/pitfalls.md")));
    }

    #[test]
    fn sha256_known_vector() {
        // "abc" 的标准 SHA-256。
        assert_eq!(
            sha256_digest(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn read_and_get_reject_everything_not_in_the_catalog() {
        let bad = [
            "file:///C:/Windows/win.ini",
            "file:///etc/passwd",
            "C:\\Windows\\win.ini",
            "/etc/passwd",
            "skill://local-edit-verify/../../Cargo.toml",
            "skill://local-edit-verify/",
            "skill://local-edit-verify",
            "skill://local-edit-verify/SKILL.md/",
            "skill://local-edit-verify/skill.md",
            "skill://no-such-skill/SKILL.md",
            "skill://local-edit-verify/references/other.md",
            "",
        ];
        for uri in bad {
            for method in ["resources/read", "skills/get"] {
                let r = call(method, json!({ "uri": uri }));
                assert_eq!(
                    r["error"]["code"],
                    json!(-32602),
                    "{method} {uri:?} 应拒绝：{r}"
                );
            }
        }
        // skills/get 要求是 SKILL.md 的 URI：缺 uri 也是 -32602。
        assert_eq!(
            call("skills/get", json!({}))["error"]["code"],
            json!(-32602)
        );
        assert_eq!(
            call("resources/read", json!({}))["error"]["code"],
            json!(-32602)
        );
        // 列表类方法合规地返回空列表（技能不靠枚举）。
        let rl = call("resources/list", json!({}));
        assert_eq!(rl["result"]["resources"], json!([]));
        assert_eq!(rl["result"]["resultType"], json!("complete"));
        let tl = call("resources/templates/list", json!({}));
        assert_eq!(tl["result"]["resourceTemplates"], json!([]));
        // 没实现的方法不处理，继续走原有的 Method not found。
        assert!(handle_method("resources/directory/read", &json!({ "id": 1 })).is_none());
        assert!(handle_method("resources/subscribe", &json!({ "id": 1 })).is_none());
    }

    #[test]
    fn capabilities_declare_resources_and_skills_together() {
        let mut caps = json!({ "tools": { "listChanged": false }, "extensions": { "io.modelcontextprotocol/tasks": {} } });
        merge_capabilities(&mut caps);
        assert!(
            caps["resources"].is_object(),
            "声明 skills 必须同时声明 resources"
        );
        assert!(caps["extensions"][EXT_SKILLS].is_object());
        assert!(
            caps["extensions"]["io.modelcontextprotocol/tasks"].is_object(),
            "不能覆盖 tasks"
        );
        // 不声明 directoryRead（我们没实现目录读）。
        assert!(caps["extensions"][EXT_SKILLS]
            .get("directoryRead")
            .is_none());
    }

    #[test]
    fn frontmatter_parser_handles_quotes_and_rejects_malformed() {
        let ok = parse_frontmatter("---\nname: a\ndescription: \"b c\"\n---\nbody").unwrap();
        assert_eq!(ok, json!({ "name": "a", "description": "b c" }));
        assert!(parse_frontmatter("no frontmatter").is_none());
        assert!(
            parse_frontmatter("---\nname: a\n---\n").is_none(),
            "缺 description"
        );
        assert!(
            parse_frontmatter("---\nname: a\ndescription: b\n").is_none(),
            "未闭合"
        );
    }
}
