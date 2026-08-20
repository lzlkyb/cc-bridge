//! 把一次工具调用转发给外挂 MCP server。
//!
//! 🔴 **`is_write: true` 是故意的**（方案 §5）：cc-bridge 无法知道外挂工具到底读还是写
//! （参数 schema 是对方定义的）。只读模式下宁可全拦住，也不能放一个可能写盘的调用过去。
//! 拦截由 `http.rs::dispatch_tool` 的 `WRITE_SET` 自动完成，本文件不需要再判一次。
//!
//! 🔴 **白名单管不着外挂 server**：它是独立进程，入参结构由它自己定义，
//! cc-bridge 既不知道哪个字段是路径，也无法限制它碰什么。**不做启发式参数扫描**
//! （方案 S5）——那拦不住真攻击，却会制造“已经防住了”的错觉。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::bridge::config::ExternalMcpServer;
use crate::mcp::bridge::DEFAULT_TIMEOUT;
use crate::security::path;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct McpProxyArgs {
    /// 外挂 server 名（见 mcp_list_servers）。
    pub server: String,
    /// 该 server 里的工具名。
    pub tool: String,
    /// 透传给它的参数，形状由它自己的 `inputSchema` 决定。
    #[serde(default)]
    pub args: Value,
    /// 这次调用的工作目录（多项目支持）。省略则用配置里管理员定的那个。
    ///
    /// 🔴 只有该 server 显式开了「允许远程指定工作目录」才接受，且必须落在
    /// 白名单根目录内。stdio server 的 cwd 在启动那一刻定死，所以每个目录
    /// 会各起一个进程。
    #[serde(default)]
    pub cwd: Option<String>,
}

/// 把客户端传来的 `args` 规整成 MCP 要求的对象。
///
/// 🔴 为何要容错而不是直接拒：真机联调里客户端把 `args` 当**字符串**发了过来
/// （审计日志实锤：`"args":"{\"query\": \"...\"}"`），而旧代码原样转发——
/// 外挂 server 一个字段都没收到，却照常返回它自己的「参数缺失」错误。
/// 于是调用**看起来**在正常工作、实际参数全丢——这是最难查的一类失败。
///
/// schema 已改成 `{"type":"object"}`（治本），这里是第二道：别的客户端同样可能这么干。
/// 解不开就**报错**，不拿一个猜测的空对象充数——宁可失败得明白。
fn normalize_args(args: Value) -> Result<Value, String> {
    match args {
        // 没传 = 无参。给 `{}` 而不是 `null`：MCP 的 `arguments` 按协议就是对象。
        Value::Null => Ok(json!({})),
        Value::Object(_) => Ok(args),
        Value::String(s) if s.trim().is_empty() => Ok(json!({})),
        Value::String(s) => match serde_json::from_str::<Value>(s.trim()) {
            Ok(v @ Value::Object(_)) => Ok(v),
            _ => Err(format!(
                "args 必须是对象（外挂工具的参数表），收到的是一个解不成 JSON 对象的字符串：{s}"
            )),
        },
        other => Err(format!(
            "args 必须是对象（外挂工具的参数表），收到的是：{other}"
        )),
    }
}

/// 校验并解析远程指定的工作目录（多项目支持）。
///
/// 🔴 白名单在这里**第一次真的能管事**。它管不住外挂 server 启动之后干什么
/// ——那是独立进程，文件是它自己打开的，cc-bridge 根本不在那条 I/O 路径上；
/// 但「从哪个目录启动」是 cc-bridge 自己的动作，这一步能管。
///
/// **但这只是粗粒度护栏，不是隔离**：限住启动目录 ≠ 限住它能碰什么，
/// 进程起来照样能 `..` 走出去。任何文案都不得写成「已限制在白名单内」——
/// 那是在造假安全感，跟 S5 拒绝的那种启发式校验同一个毛病。
///
/// 白名单本身被关掉时（`whitelist_enabled = false`），这道护栏也跟着没了。
/// 这是一致的：那个开关的语义本来就是「远程可访问本机全部文件」。
/// 子开关的门禁。抽成纯函数只为一件事：让「未开启时必须**报错**、不得静默忽略」
/// 这条能被单测钉住——静默忽略会让模型以为切到了 A 项目、实际查的是 B，
/// 那是比直接失败难查得多的一类 bug。
fn gate_remote_cwd<'a>(
    cwd: Option<&'a str>,
    spec: &ExternalMcpServer,
) -> Result<Option<&'a str>, String> {
    let Some(requested) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if !spec.allow_remote_cwd {
        return Err(format!(
            "`{}` 未开启「允许远程指定工作目录」，它当前固定在 {}。要按项目切换，需本机管理员在设置页为它显式开启。",
            spec.name,
            spec.cwd.as_deref().unwrap_or("cc-bridge 自己的工作目录")
        ));
    }
    Ok(Some(requested))
}

async fn resolve_remote_cwd(
    args: &McpProxyArgs,
    spec: &ExternalMcpServer,
    state: &Arc<AppState>,
) -> Result<Option<PathBuf>, String> {
    let Some(requested) = gate_remote_cwd(args.cwd.as_deref(), spec)? else {
        return Ok(None);
    };
    let (roots, enforce, listed) = {
        let c = state.config.read().await;
        (
            state.cached_roots(),
            c.whitelist_enabled,
            c.allowed_roots.clone(),
        )
    };
    let resolved = path::resolve_safe_path_cached(requested, &roots, enforce).map_err(|e| {
        format!(
            "工作目录 `{requested}` 不可用：{e}
可用的白名单根目录：{}",
            listed.join("、")
        )
    })?;
    // 目录不存在时早报错：否则进程会以一个莫名其妙的 cwd 起来，
    // 而对方吐出的错误往往看不出根因（真机联调里就吃过这个亏）。
    if !resolved.is_dir() {
        return Err(format!("工作目录 `{requested}` 不是一个存在的目录。"));
    }
    Ok(Some(resolved))
}

pub async fn handle(args: McpProxyArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let (enabled, spec) = {
        let c = state.config.read().await;
        let spec = c
            .external_mcp_servers
            .iter()
            .find(|s| s.name == args.server)
            .cloned();
        (c.external_mcp_enabled, spec)
    };

    if !enabled {
        return Err(
            "外挂 MCP server 功能未启用。它等于给远程多开一条执行通道，需本机管理员在设置页显式开启。"
                .to_string(),
        );
    }
    let spec = spec.ok_or_else(|| {
        format!(
            "没有叫 `{}` 的外挂 server。先调 mcp_list_servers 看看有哪些。",
            args.server
        )
    })?;
    if !spec.enabled {
        return Err(format!("外挂 server `{}` 未启用。", spec.name));
    }

    // 多项目：远程指定的工作目录。
    let cwd = resolve_remote_cwd(&args, &spec, state).await?;

    let st = Arc::clone(state);
    let name = spec.name.clone();
    let tool = args.tool.clone();
    let call_args = normalize_args(args.args)?;

    // 阻塞活丢进 blocking 线程池（跟 run_command 同一套）。
    let outcome = tokio::task::spawn_blocking(move || {
        let sess = st
            .mcp_bridge
            .session(&spec, cwd.as_deref(), DEFAULT_TIMEOUT)?;
        let (r, poisoned, tail) = {
            let mut s = sess.lock().map_err(|_| "会话锁中毒".to_string())?;
            let r = s.client()?.call_tool(&tool, call_args, DEFAULT_TIMEOUT);
            // 中毒就不能再用了（迟到的响应会跟下一次请求对错号）。
            let poisoned = s.client().map(|c| c.is_poisoned()).unwrap_or(true);
            (r, poisoned, s.stderr_tail())
        }; // 🔴 先放会话锁：`drop_session` 内部要拿它，持着调就是死锁。

        // 🔴 摘掉中毒会话必须在**这里**做，不能交给外层。
        //
        // 真机联调踩到：客户端等不及先断开时，整个请求 future 被取消，
        // 外层那句 `if poisoned { drop_session }` 根本没机会跑——中毒的会话
        // 会继续赖在池里，下一个调用者必吃一次「连接已不可用」。
        // 而 blocking 任务本身不受取消影响，放在它里面就一定执行得到。
        if poisoned {
            // 只摘这一个（server, cwd）：A 项目的连接中毒了，
            // 不该把 B 项目健康的会话一起关掉。
            st.mcp_bridge.drop_one(&spec, cwd.as_deref());
        }
        // 闭包里用了 `?`，所以它必须返回 `Result`；外层再拆一层 `JoinError`。
        Ok::<_, String>((r, tail))
    })
    .await
    .map_err(|e| format!("转发任务 panic：{e}"))?;

    let (result, stderr_tail) = outcome?;

    match result {
        Ok(c) => Ok(json!({
            "content": c.content,
            "isError": c.is_error,
        })),
        Err(e) if stderr_tail.is_empty() => Err(e),
        // 启动/运行出错时，真正的原因往往只在对方的 stderr 里。
        Err(e) => Err(format!(
            "{e}\n{name} 的 stderr：\n{}",
            stderr_tail.join("\n")
        )),
    }
}

/// 追加到 `mcp_proxy` 描述里的关键词总预算（字符数）。
///
/// 这段文字进的是 `tools/list`，每次（重）连接都会灼进客户端上下文，所以必须有硬上限：
/// 挂 5 个 server × 每个 30 个工具时不能无限膨胀。超预算就停在上一个 server。
const KEYWORD_BUDGET: usize = 1200;
/// 每个 server 最多列几个工具名。
const MAX_TOOLS_PER_SERVER: usize = 40;
/// 单个工具名最长字符数。
const MAX_NAME_LEN: usize = 64;

/// 在 `mcp_proxy` 的静态描述后面，追加**当前已挂载 server 的工具名清单**。
///
/// # 这是喂给检索索引的，不是给人读的
///
/// 客户端（Claude Code v2.1.7+ 默认开 Tool Search）不再把全部工具描述常驻上下文，
/// 而是按需检索。实测它检索的是**完整描述文本**而不只是工具名：搜 `heuristic`
/// （一个只出现在描述里、任何工具名都没有的词）能精确命中 `analyze_file` 与
/// `read_files` 这两个描述里含该词的工具。
///
/// 于是问题就清楚了：`mcp_proxy` 原来的描述里**一个领域词都没有**。模型要查代码结构时
/// 检索不到它，外挂 server 等于隐身——发现它的唯一路径是模型先莫名想到调
/// `mcp_list_servers`，而那个念头本身正是需要被触发的东西。把 `codegraph_callers`、
/// `codegraph_impact` 这类名字放进描述，就是**给索引喂领域词**，让它在使用现场浮出来。
///
/// # 为什么只放工具名，不放外挂 server 自己写的摘要
///
/// 摘要是 tool poisoning 的入口（Invariant Labs 2025-04 首个 PoC；MCPTox 在 45+ 真实
/// server 上实测成功率 >60%）。工具**名**是受字符集与长度约束的标识符，注入空间小得多。
///
/// 先只用名字试效果：**名字够用的话，我们永远不必承担那个风险**。不够用再加摘要，
/// 但那之前必须先做「描述哈希 + 变更重新批准」（rug pull，CVE-2025-54136）——否则
/// 用户点「启用」时批准的文本，server 事后改掉也没人知道。
///
/// # 零进程启动
///
/// 只读持久化的 manifest，与 `mcp_list_servers` 同一条纪律。`tools/list` 是每次连接
/// 必发的请求，在这里冷启动子进程等于把「连一下看看」变成十几秒。
///
/// 返回 `None` 表示没有可追加的内容（总开关关、或一个有缓存的 server 都没有），
/// 此时描述保持静态原样。
pub async fn keyword_hint(state: &Arc<AppState>) -> Option<String> {
    let (enabled, specs) = {
        let c = state.config.read().await;
        (c.external_mcp_enabled, c.external_mcp_servers.clone())
    };
    if !enabled {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    for spec in specs.iter().filter(|s| s.enabled && s.is_stdio()) {
        let cached = {
            let db = state.db.lock().await;
            crate::mcp::bridge::manifest::load(&db, &spec.name)
                .ok()
                .flatten()
        };
        let Some(m) = cached else { continue };
        let names = searchable_tool_names(&m.tools);
        if names.is_empty() {
            continue;
        }
        // server 名来自用户自己的配置，原样保留：改写会让模型拿着一个调不通的名字去调。
        // 只挡换行——它会把描述截成两段，破坏原本的行结构。
        let server = spec.name.replace(['\n', '\r'], " ");
        let line = format!("- {}: {}", server, names.join(", "));
        let cost = line.chars().count();
        if used + cost > KEYWORD_BUDGET {
            break;
        }
        used += cost;
        lines.push(line);
    }

    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "\n\nCurrently bridged servers and their tool names (listed so you can tell whether one is \
         relevant — call mcp_list_servers for summaries and input schemas):\n{}",
        lines.join("\n")
    ))
}

/// 从 manifest 的工具数组里挑出**可以安全放进描述**的工具名。
///
/// 🔴 不合规的名字**整条丢掉，不改写**。改写出来的名字调不通，会让模型拿着一个
/// 不存在的工具名去调 `mcp_proxy`，比不列它更糟。
fn searchable_tool_names(tools: &Value) -> Vec<String> {
    tools
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
        .filter(|n| {
            !n.is_empty()
                && n.chars().count() <= MAX_NAME_LEN
                && n.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        })
        .take(MAX_TOOLS_PER_SERVER)
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 回归测试：真机联调里客户端真的这么发了。
    /// 旧代码把这个字符串原样当成 `arguments` 转发，所有参数静默丢失。
    #[test]
    fn parses_stringified_object() {
        let v = normalize_args(json!(r#"{"query": "resolve_program"}"#)).expect("应解开");
        assert_eq!(v["query"], "resolve_program");
    }

    /// 没传参数时给 `{}` 而不是 `null`：MCP 的 `arguments` 按协议就是对象。
    #[test]
    fn null_becomes_empty_object() {
        assert_eq!(normalize_args(Value::Null).expect("ok"), json!({}));
        assert_eq!(normalize_args(json!("  ")).expect("ok"), json!({}));
    }

    #[test]
    fn object_passes_through_untouched() {
        let orig = json!({"a": 1, "b": [2, 3]});
        assert_eq!(normalize_args(orig.clone()).expect("ok"), orig);
    }

    /// 解不开就报错，**不拿空对象充数**——那就又变回了静默丢参数。
    #[test]
    fn rejects_what_it_cannot_understand() {
        for bad in [
            json!("not json at all"),
            json!("[1,2]"),
            json!(42),
            json!([1]),
        ] {
            let e = normalize_args(bad.clone()).expect_err("应报错");
            assert!(e.contains("args 必须是对象"), "{bad} 的错误文案不对：{e}");
        }
    }

    fn spec(allow: bool) -> ExternalMcpServer {
        ExternalMcpServer {
            name: "s".into(),
            transport: "stdio".into(),
            command: "x".into(),
            args: vec![],
            env: vec![],
            cwd: Some("C:/fixed".into()),
            enabled: true,
            allow_remote_cwd: allow,
        }
    }

    /// 🔴 没开子开关却传了 cwd → 必须**报错**。
    ///
    /// 静默忽略是最坏的选择：模型以为切到了 A 项目、实际查的是 B，
    /// 而两边都返回了看起来正常的结果。
    #[test]
    fn rejects_cwd_when_switch_is_off() {
        let e = gate_remote_cwd(Some("C:/other"), &spec(false)).expect_err("应报错");
        assert!(e.contains("允许远程指定工作目录"), "错误得说清原因：{e}");
        assert!(e.contains("C:/fixed"), "得告诉它当前固定在哪：{e}");
    }

    /// 没传 cwd 时，开不开子开关都放行（走配置里的目录，行为与改动前一致）。
    #[test]
    fn absent_cwd_is_always_fine() {
        assert_eq!(gate_remote_cwd(None, &spec(false)).expect("ok"), None);
        assert_eq!(
            gate_remote_cwd(Some("   "), &spec(false)).expect("ok"),
            None
        );
        assert_eq!(gate_remote_cwd(None, &spec(true)).expect("ok"), None);
    }

    /// 开了就放行，并把两端空白去掉。
    #[test]
    fn accepts_and_trims_when_switch_is_on() {
        assert_eq!(
            gate_remote_cwd(Some("  C:/proj  "), &spec(true)).expect("ok"),
            Some("C:/proj")
        );
    }

    /// 合规名字原样留下，不合规的**整条丢掉而不是改写**。
    ///
    /// 🔴 改写是比丢弃更坏的选项：`bad name!` 洗成 `badname` 后，模型会拿这个
    /// 根本不存在的工具名去调 `mcp_proxy`，拿到一个莫名其妙的“工具不存在”。
    #[test]
    fn drops_unusable_tool_names_instead_of_rewriting_them() {
        let tools = json!([
            {"name": "codegraph_explore"},
            {"name": "a.b-c_1"},
            {"name": "bad name!"},
            {"name": "中文工具"},
            {"name": ""},
            {"name": "x".repeat(MAX_NAME_LEN + 1)},
            {"summary": "没有 name 字段"}
        ]);
        assert_eq!(
            searchable_tool_names(&tools),
            vec!["codegraph_explore".to_string(), "a.b-c_1".to_string()],
            "只留完全合规的，且不得出现被“洗干净”的变体"
        );
    }

    /// 长度刚好卡在上限上的名字要留下（边界是 `<=` 不是 `<`）。
    #[test]
    fn name_at_exactly_max_len_is_kept() {
        let exact = "n".repeat(MAX_NAME_LEN);
        assert_eq!(searchable_tool_names(&json!([{"name": exact}])), vec![exact]);
    }

    /// 工具多的 server 要截断，否则一个 server 就能吃掉全部预算。
    #[test]
    fn caps_tool_count_per_server() {
        let many: Vec<Value> = (0..MAX_TOOLS_PER_SERVER + 10)
            .map(|i| json!({"name": format!("t{i}")}))
            .collect();
        assert_eq!(
            searchable_tool_names(&Value::Array(many)).len(),
            MAX_TOOLS_PER_SERVER
        );
    }

    /// 不是数组也不能 panic——manifest 里的 `tools` 是外挂 server 给的，形状不受我们控制。
    #[test]
    fn tolerates_malformed_manifest_shapes() {
        for bad in [json!(null), json!("不是数组"), json!({"tools": []}), json!(7)] {
            assert!(searchable_tool_names(&bad).is_empty(), "{bad} 应该得到空");
        }
    }

    /// 🔴 schema 必须声明 `args` 是对象。少了这一行，客户端就有理由把它
    /// 当字符串发——本次真机联调里就是这么坏的。
    #[test]
    fn schema_declares_args_as_object() {
        let schema = McpProxyArgs::schema();
        assert_eq!(
            schema["properties"]["args"]["type"], "object",
            "args 必须声明为 object，否则客户端会按字符串发，参数会静默丢失"
        );
    }
}
