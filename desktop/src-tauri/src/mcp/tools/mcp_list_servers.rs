//! 外挂 MCP server 的**发现入口**。
//!
//! 🔴 默认只给**紧凑索引**（工具名 + 一句话），不带 `inputSchema`。
//! N 个 server × 每个十几个工具的完整 schema 是很大一坨，而它是工具**返回值**——
//! 客户端不会像 `tools/list` 那样缓存，每次新会话都得重新灼进上下文。
//!
//! 🔴 **零进程启动**：数据全部来自持久化的 manifest。只有显式传 `refresh: true`
//! 才会去拉起 server 重抓——否则模型“看看有什么工具”会把所有 server 冷启动一遍。

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::bridge::{config::ExternalMcpServer, manifest, spawn, DEFAULT_TIMEOUT};
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct McpListServersArgs {
    /// 只看某个 server，并返回它的**完整 schema** 与 instructions。
    #[serde(default)]
    pub server: Option<String>,
    /// 配合 `server` 使用：只要这一个工具的完整 schema。
    #[serde(default)]
    pub tool: Option<String>,
    /// 重新抓取工具清单（**会启动子进程**）。配置改过且提示 stale 时才需要。
    #[serde(default)]
    pub refresh: bool,
    /// 连没装 / 未启用的也列出来（默认不列，避免噪声）。
    #[serde(default, rename = "includeUnavailable")]
    pub include_unavailable: bool,
}

pub async fn handle(args: McpListServersArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let (enabled, specs) = {
        let c = state.config.read().await;
        (c.external_mcp_enabled, c.external_mcp_servers.clone())
    };

    if !enabled {
        return text(json!({
            "enabled": false,
            "servers": [],
            "note": "外挂 MCP server 功能未启用。它等于给远程多开一条执行通道，必须由本机管理员在设置页显式开启。"
        }));
    }

    if args.refresh {
        // 只刷点名的那一个。不过滤的话，模型为一个 stale 的 server 传
        // `{server:"x", refresh:true}` 会把**全部**已启用的 server 都冷启动一遍——
        // 十几秒不说，还拉起了用户并没打算启动的进程。工具描述里写的也是单数。
        let targets: Vec<_> = specs
            .iter()
            .filter(|s| args.server.as_deref().is_none_or(|w| s.name == w))
            .cloned()
            .collect();
        refresh_all(&targets, state).await;
    }

    let mut out: Vec<Value> = Vec::new();
    for spec in &specs {
        if let Some(want) = &args.server {
            if &spec.name != want {
                continue;
            }
        }
        let entry = describe(spec, state, args.server.is_some(), args.tool.as_deref()).await?;
        let available = entry["state"] != "not_installed" && entry["state"] != "disabled";
        if available || args.include_unavailable || args.server.is_some() {
            out.push(entry);
        }
    }

    text(json!({ "enabled": true, "servers": out }))
}

/// 描述一个 server。**不启进程**：只查命令在不在 + 读 manifest。
async fn describe(
    spec: &ExternalMcpServer,
    state: &Arc<AppState>,
    detailed: bool,
    only_tool: Option<&str>,
) -> Result<Value, String> {
    if !spec.enabled {
        return Ok(json!({ "name": spec.name, "state": "disabled" }));
    }
    if !spec.is_stdio() {
        return Ok(json!({
            "name": spec.name, "state": "unsupported",
            "error": format!("第一步只支持 stdio 型，它是 `{}`", spec.transport)
        }));
    }
    // 仅查可执行文件在不在，不启它。
    if let Err(e) = spawn::resolve_program(&spec.command) {
        return Ok(json!({ "name": spec.name, "state": "not_installed", "error": e }));
    }

    let cached = {
        let db = state.db.lock().await;
        manifest::load(&db, &spec.name)?
    };
    let Some(m) = cached else {
        return Ok(json!({
            "name": spec.name, "state": "stale",
            "note": "还没有工具清单。传 refresh:true 可启动它并抓一次。"
        }));
    };
    if m.is_stale_for(spec) {
        return Ok(json!({
            "name": spec.name, "state": "stale", "toolCount": m.tool_count(),
            "note": "配置已改，缓存的工具清单可能过时。传 refresh:true 重抓。"
        }));
    }

    // 默认紧凑；指定了 server 才给完整 schema。
    let tools = if !detailed {
        manifest::compact_index(&m.tools)
    } else if let Some(t) = only_tool {
        let one: Vec<Value> = m
            .tools
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or(&[])
            .iter()
            .filter(|x| x.get("name").and_then(|n| n.as_str()) == Some(t))
            .cloned()
            .collect();
        Value::Array(one)
    } else {
        m.tools.clone()
    };

    let mut e = json!({
        "name": spec.name,
        "state": "ready",
        "toolCount": m.tool_count(),
        "serverInfo": m.server_info,
        "tools": tools,
    });
    if detailed {
        // instructions 只在详情里给：它是一段 Markdown，N 个 server 全拼进索引会很重。
        e["instructions"] = json!(m.instructions);
    }
    // 多项目：不告诉模型它就不会用，而这个功能的全部意义就是让它能按项目切。
    // 连可用根目录一起给——否则它只能靠猜路径、猜错了吃一堆报错。
    if spec.allow_remote_cwd {
        e["acceptsCwd"] = json!(true);
        e["allowedCwdRoots"] = json!(state.config.read().await.allowed_roots);
    }
    Ok(e)
}

/// 刷新给定的几个 server 的工具清单。
///
/// **整个函数不返回错误**：刷新是列表的附带动作，单个 server 失败不应该让
/// 模型连已经拓好的那部分列表都拿不到（旧实现里 `manifest::save` 与 JoinError
/// 的 `?` 会直接结束整个调用，而注释却写着“单个失败不阻断其他”）。
async fn refresh_all(specs: &[ExternalMcpServer], state: &Arc<AppState>) {
    for spec in specs {
        if !spec.enabled || !spec.is_stdio() {
            continue;
        }
        let spec2 = spec.clone();
        let st = Arc::clone(state);
        // 阻塞活（spawn + 握手 + 管道读写）一律丢进 blocking 线程池，跟 run_command 同一套做法。
        let joined = tokio::task::spawn_blocking(move || {
            // 刷新走配置里的 cwd：这是「这个 server 长什么样」，不是某个项目的视图。
            let sess = st.mcp_bridge.session(&spec2, None, DEFAULT_TIMEOUT)?;
            let mut s = sess.lock().map_err(|_| "会话锁中毒".to_string())?;
            let captured = manifest::capture(s.client()?, &spec2, DEFAULT_TIMEOUT, now_secs());
            // 中毒就不能再用了（迟到的响应会跟下一次请求对错号），跟 mcp_proxy 同一套判法。
            let poisoned = s.client().map(|c| c.is_poisoned()).unwrap_or(true);
            Ok::<_, String>((captured, poisoned))
        })
        .await;

        let outcome = match joined {
            Ok(v) => v,
            Err(e) => {
                log::warn!("刷新外挂 MCP server {} 的任务 panic：{e}", spec.name);
                continue;
            }
        };
        let (captured, poisoned) = match outcome {
            Ok(v) => v,
            Err(e) => {
                log::warn!("刷新外挂 MCP server {} 失败：{e}", spec.name);
                continue;
            }
        };
        // 不摘掉的话：中毒的会话会一直赖在池里，之后每次 `refresh:true`
        // 都直接返回「连接已不可用」，永远不重建。
        if poisoned {
            // 只摘中毒的这一个（默认 cwd），别把其它项目健康的会话连坐。
            state.mcp_bridge.drop_one(spec, None);
        }
        match captured {
            Ok(m) => {
                let db = state.db.lock().await;
                if let Err(e) = manifest::save(&db, &m) {
                    log::warn!("写入 {} 的工具清单失败：{e}", spec.name);
                }
            }
            Err(e) => log::warn!("刷新外挂 MCP server {} 失败：{e}", spec.name),
        }
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn text(v: Value) -> Result<Value, String> {
    Ok(json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?
        }]
    }))
}
