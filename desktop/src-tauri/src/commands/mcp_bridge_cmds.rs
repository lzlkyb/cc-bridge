//! 外挂 MCP 桥的 IPC 命令层（方案 `docs/mcp-bridge-step1-plan.md` 阶段 6）。
//!
//! 🔴 **这里的每一个写命令都等于「以本机用户身份执行任意程序」的授权**（S1）。
//! `run_command` 有三道闸（`shell_enabled` 默认关 + 危险命令拦截 + 命令白名单），
//! 而桥接的 spawn 一道都不走——唯一的闸就是「只能从本机面板改配置」。
//! 所以这些命令**绝不注册为 MCP 工具**，只经 Tauri invoke 暴露给本机前端。
//!
//! 为何不走 `save_config` 的 patch：那个接口是「整数组替换」，后端无法区分
//! 「用户改了一条」与「一次性提交了五条新的」，S1 要求的逐次审计根本写不出来。
//! 拆成粒度命令后，每一次变更都能单独落审计、单独过 S8 自我校验。

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::audit;
use crate::config::save_config_field;
use crate::mcp::bridge::{self, config::ExternalMcpServer, import, manifest, session, spawn};
use crate::state::AppState;

/// 配置列表存在 config 表的这个键下（跟 `allowed_roots` 同套做法）。
const KEY_SERVERS: &str = "external_mcp_servers";
const KEY_ENABLED: &str = "external_mcp_enabled";

// ===== 出参结构 =====

/// 给前端的一条 server。
///
/// 🔴 **`env` 只出键名**（S7）。不是前端不显示，是后端根本不传——
/// 本机 `paper_search_mcp` 的 env 里就是真的 API key。
#[derive(Debug, Serialize)]
pub struct BridgeServerView {
    pub name: String,
    pub transport: String,
    /// 原样给，**不做任何解析**（S0/S5）：用户得看得见自己要交出去的是 `D:` 还是子目录。
    pub command: String,
    pub args: Vec<String>,
    #[serde(rename = "envKeys")]
    pub env_keys: Vec<String>,
    pub cwd: Option<String>,
    /// `cwd` 为空时实际生效的目录（= cc-bridge 自己的工作目录）。
    ///
    /// 要单独算出来给前端：那个目录**不在白名单控制下**，不显示的话用户根本
    /// 不知道子进程的相对路径从哪里起算（S0）。
    #[serde(rename = "effectiveCwd")]
    pub effective_cwd: Option<String>,
    pub enabled: bool,
    /// 是否允许远程按调用指定工作目录（多项目支持）。
    #[serde(rename = "allowRemoteCwd")]
    pub allow_remote_cwd: bool,
    /// 当前活着的实例（各自的工作目录）。不展示的话，用户不知道自己开了几个进程。
    #[serde(rename = "liveCwds")]
    pub live_cwds: Vec<String>,
    /// `ready` / `stale` / `unknown` / `not_installed` / `failed`。
    pub state: String,
    #[serde(rename = "toolCount")]
    pub tool_count: usize,
    #[serde(rename = "fetchedAt", skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<i64>,
    /// 工具紧凑索引（名字 + 一句话）。没 manifest 时为空数组。
    ///
    /// 不带 `inputSchema`：那东西很大，而界面上只需要“这东西能干什么”。
    pub tools: Value,
    /// server 自己给的说明（MCP 的**可选**字段，很多 server 不提供）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// `failed` / `not_installed` 时的**原文**。不改写成「启动失败」这种没信息量的话。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 导入向导里「运行一下」的结果。
#[derive(Debug, Serialize)]
pub struct BridgeInspectResult {
    /// `ready` / `failed`。
    pub state: String,
    #[serde(rename = "toolCount")]
    pub tool_count: usize,
    pub tools: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// 失败原文 + 对方的 stderr。不改写。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BridgeListResult {
    pub enabled: bool,
    pub servers: Vec<BridgeServerView>,
}

#[derive(Debug, Serialize)]
pub struct BridgeScanResult {
    pub candidates: Vec<Value>,
    /// 实际读到的来源文件（读不到的静默跳过，但要告诉用户扫了哪几处）。
    pub sources: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BridgeProbeResult {
    pub state: String,
    #[serde(rename = "toolCount")]
    pub tool_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 前端提交的一条 server。
///
/// 注意**没有 `enabled`**：启用只能走 `mcp_bridge_set_enabled`。
/// 两条路都能改启用状态的话，总有一条会忘了写审计。
#[derive(Debug, Deserialize)]
pub struct ServerInput {
    pub name: String,
    #[serde(default)]
    pub transport: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// `[[key, value]]`。前端传值是单向的（只进不出，S7）。
    ///
    /// 🔴 `None` = **保持现有不变**，`Some([])` = 清空。
    /// 两者必须分开：前端拿不到现有的 env **值**（只有键名），
    /// 若把“没填”当成“清空”，用户改一下参数就会静默把 API key 弄没。
    #[serde(default)]
    pub env: Option<Vec<(String, String)>>,
    #[serde(default)]
    pub cwd: Option<String>,
}

// ===== 读取 =====

/// 列出已配置的 server 及其状态。
///
/// 🔴 **不启动任何子进程**。数据全来自配置 + 持久化的 manifest + 一次 PATH 查找。
/// 否则用户每点一次设置页就会静默拉起 N 个进程（包括那个能交出整个 `D:` 的），
/// 而他只是想改个备份目录。启进程只能由 `mcp_bridge_probe` 显式触发。
///
/// 性能（§8.1）：最贵的是每个 server 一次 `resolve_program`。
///
/// **实测（本机，PATH 27 条，debug 构建）：三个 server 共 55ms；命令不存在时
/// 单个就要 32ms**（要把 PATH × PATHEXT 扫满）。开销是 syscall 主导的，
/// release 构建不会明显变快。比当初估的「≤10ms」高一个量级，因此：
///
/// - 无循环、无定时器，只在本卡挂载与写操作后调；
/// - **绝不能挂到 `onSaved` 全局刷新链上**——那条链每改一个开关就跑一次，
///   每次都要多花几十毫秒。
#[tauri::command]
pub async fn mcp_bridge_list(state: State<'_, Arc<AppState>>) -> Result<BridgeListResult, String> {
    let (enabled, specs) = {
        let cfg = state.config.read().await;
        (cfg.external_mcp_enabled, cfg.external_mcp_servers.clone())
    };
    // 顺手回收空闲会话：惰性回收没有后台任务，靠这里和 `session()` 两个入口触发。
    state.mcp_bridge.sweep_idle();

    // 继承来的工作目录：算一次就好，所有 server 用同一个。
    let inherited = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    let db = state.db.lock().await;
    let mut servers = Vec::with_capacity(specs.len());
    for spec in &specs {
        servers.push(view_of(spec, &db, &state.mcp_bridge, inherited.as_deref()));
    }
    drop(db);

    // 固定排序：已启用在前，同组内按名字。不做可配排序——本机才 3 个，
    // 但顺序必须稳定，否则每次打开设置页列表都在跳。
    servers.sort_by(|a, b| b.enabled.cmp(&a.enabled).then_with(|| a.name.cmp(&b.name)));
    Ok(BridgeListResult { enabled, servers })
}

fn view_of(
    spec: &ExternalMcpServer,
    db: &rusqlite::Connection,
    pool: &bridge::McpBridge,
    inherited: Option<&str>,
) -> BridgeServerView {
    let mut state = "unknown".to_string();
    let mut tool_count = 0usize;
    let mut fetched_at = None;
    let mut error = None;
    let mut tools = Value::Array(vec![]);
    let mut instructions = None;

    // 优先级：命令不存在 > 上次启动失败 > manifest 状态。
    // 命令都找不到时再报「需刷新」毫无意义。
    if let Err(e) = spawn::resolve_program(&spec.command) {
        state = "not_installed".into();
        error = Some(e);
    } else if let Some(e) = pool.last_failure(&spec.name) {
        state = "failed".into();
        error = Some(e);
    } else if let Ok(Some(m)) = manifest::load(db, &spec.name) {
        tool_count = m.tool_count();
        fetched_at = Some(m.fetched_at);
        tools = manifest::compact_index(&m.tools);
        instructions = m.instructions.clone();
        state = if m.is_stale_for(spec) {
            "stale"
        } else {
            "ready"
        }
        .into();
    }

    BridgeServerView {
        name: spec.name.clone(),
        transport: spec.transport.clone(),
        command: spec.command.clone(),
        args: spec.args.clone(),
        env_keys: spec.env.iter().map(|(k, _)| k.clone()).collect(),
        cwd: spec.cwd.clone(),
        effective_cwd: match &spec.cwd {
            Some(_) => None,
            None => inherited.map(|s| s.to_string()),
        },
        enabled: spec.enabled,
        allow_remote_cwd: spec.allow_remote_cwd,
        live_cwds: pool
            .live_cwds(&spec.name)
            .into_iter()
            .map(|c| match c {
                Some(p) => p.to_string_lossy().into_owned(),
                None => inherited.unwrap_or("(跟随 cc-bridge)").to_string(),
            })
            .collect(),
        state,
        tool_count,
        fetched_at,
        tools,
        instructions,
        error,
    }
}

/// 扫描本机已有的 MCP 客户端配置，返回候选预览。
///
/// 只读，不写任何东西，也不启进程。预览里 `env` 只有键名（S7）。
#[tauri::command]
pub async fn mcp_bridge_scan(state: State<'_, Arc<AppState>>) -> Result<BridgeScanResult, String> {
    let existing: Vec<ExternalMcpServer> = state.config.read().await.external_mcp_servers.clone();
    let taken: Vec<String> = existing.iter().map(|s| s.name.clone()).collect();

    let (mut cands, sources) = scan_sources();
    // S8：把指向 cc-bridge 自己的标为不可用（列出来但置灰）。
    import::mark_self(&mut cands);
    // 已导入的也置灰。必须在 `resolve_names` **之前**，否则它会先被改成 xxx-2，
    // 于是永远对不上已有的那一条。
    import::mark_already_imported(&mut cands, &existing);
    let renamed = import::resolve_names(&mut cands, &taken);

    let db = state.db.lock().await;
    // 顺手清孤儿 manifest（运行过但没导入的那些）。零定时器，与 `sweep_idle` 同思路。
    // 失败不阻断扫描：清不掉垃圾不是用户现在要解决的事。
    let _ = manifest::purge_orphans(
        &db,
        &taken,
        chrono::Local::now().timestamp() - manifest::ORPHAN_TTL_SECS,
    );

    let candidates = cands
        .iter()
        .map(|c| {
            let mut v = c.to_preview();
            // 被改过名的带上原名，否则用户在列表里找不到自己熟悉的那个名字。
            if let Some((from, _)) = renamed.iter().find(|(_, to)| *to == c.spec.name) {
                v["renamedFrom"] = json!(from);
            }
            // 之前运行过就直接带上工具清单，不让用户重新开向导后再跑一遍。
            // 指纹对不上（命令/参数改过）就当没有——旧清单比没有更坏。
            if let Ok(Some(m)) = manifest::load(&db, &c.spec.name) {
                if !m.is_stale_for(&c.spec) {
                    v["tools"] = manifest::compact_index(&m.tools);
                    v["toolCount"] = json!(m.tool_count());
                    if let Some(i) = &m.instructions {
                        v["instructions"] = json!(i);
                    }
                }
            }
            v
        })
        .collect();
    drop(db);

    Ok(BridgeScanResult {
        candidates,
        sources,
    })
}

// ===== 写入（每一条都过三道校验 + 写审计）=====

/// 三道校验，缺一不可。
///
/// 第二道（S8 自我引用）在导入时已经滤过一次，这里**必须再校一次**：
/// 用户完全可以绕过导入向导手动添加一条指向 cc-bridge 自己的。
fn validate(spec: &ExternalMcpServer) -> Result<(), String> {
    ExternalMcpServer::validate_name(&spec.name)?;
    if !spec.is_stdio() {
        return Err(format!(
            "传输类型 `{}` 暂不支持，第一步只支持 stdio。",
            spec.transport
        ));
    }
    if spec.command.trim().is_empty() {
        return Err("command 不能为空。".into());
    }
    // 命令现在解不出来不是拒绝理由（可能还没装），但能解出来就得看看是不是自己。
    if let Ok(p) = spawn::resolve_program(&spec.command) {
        if spawn::is_self_executable(&p) {
            return Err("这条指向的就是 cc-bridge 自己，无需也不能桥接。\
                 远程本来就直连着它，内置工具已在 tools/list 里；自己桥自己会形成循环。"
                .into());
        }
    }
    Ok(())
}

/// 读-改-写必须在**同一段临界区**里完成。
///
/// 旧写法是「读锁克隆 → 改 → 再取写锁落盘」，两段之间没有互斥：
/// 快速连点两个开关、或导入向导与行内开关同时提交，后一次会拿着旧快照
/// **整份覆盖**，前一次的改动静默消失。
///
/// 闭包里允许跑 `validate`（会查 PATH，~10ms/条）：这是人手动触发的低频操作，
/// 而把校验挪到锁外就会重新开出 TOCTOU 窗口——正确性优先。
async fn mutate<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&mut Vec<ExternalMcpServer>) -> Result<T, String>,
) -> Result<T, String> {
    // 锁顺序跟 `save_config` 一致（db 在外、config 在内），不得倒置——两边不一致就是死锁。
    let db = state.db.lock().await;
    let mut cfg = state.config.write().await;
    let mut servers = cfg.external_mcp_servers.clone();
    let out = f(&mut servers)?;
    let value = serde_json::to_value(&servers).map_err(|e| format!("序列化失败：{e}"))?;
    // 先写 DB 再改内存（与 `save_config` 的 `apply_field!` 同一约定）：
    // 写盘失败时内存不会领先于 DB。
    save_config_field(&db, KEY_SERVERS, &value)?;
    cfg.external_mcp_servers = servers;
    Ok(out)
}

/// 写审计。
///
/// 🔴 `params` 里**绝不能出现 env 值**（S7）——审计日志是落盘的，
/// 写进去就等于把 API key 明文存到了 `audit.log`。统一走 `env_key_summary`。
fn audit_change(state: &Arc<AppState>, action: &str, params: Value, error: Option<String>) {
    let entry = audit::new_entry(
        action,
        &params.to_string(),
        error.is_none(),
        error,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    let _ = audit::write_audit_log(&state.data_dir, &entry);
}

/// 审计用的 spec 摘要。
fn brief(spec: &ExternalMcpServer) -> Value {
    json!({
        "name": spec.name,
        "command": spec.command,
        "args": spec.args,
        "envKeys": spawn::env_key_summary(&spec.env),
        "cwd": spec.cwd,
    })
}

/// 导入选中的几条。**全部 `enabled=false`**（S2）。
///
/// 重新扫一遍而不是相信前端传回来的 spec：前端拿到的预览**没有 env 值**（S7），
/// 真要存得回源文件取；而且接受前端传完整 spec 等于多一条写入路径，没必要。
#[tauri::command]
pub async fn mcp_bridge_import(
    state: State<'_, Arc<AppState>>,
    names: Vec<String>,
) -> Result<Value, String> {
    let state = state.inner();
    // 扫描与自我识别都碰文件系统（读配置 / 解析 PATH），放在锁外。
    let (mut cands, _) = scan_sources();
    import::mark_self(&mut cands);

    let (briefs, imported, skipped) = mutate(state, move |servers| {
        // 名字避让与重复判定都得基于临界区内的现状，否则并发下会算出过时的结果——
        // 两个窗口同时导同一条时，后一个必须看到前一个已经存进去了。
        let taken: Vec<String> = servers.iter().map(|s| s.name.clone()).collect();
        import::mark_already_imported(&mut cands, servers);
        import::resolve_names(&mut cands, &taken);

        let mut briefs = Vec::new();
        let mut imported = Vec::new();
        let mut skipped = Vec::new();
        for name in &names {
            match cands.iter().find(|c| c.spec.name == *name) {
                // 不可导入的直接跳过：前端已置灰，能走到这里只能是反向构造的调用。
                Some(c) if c.status == import::CandidateStatus::Importable => {
                    let spec = c.spec.clone();
                    if let Err(e) = validate(&spec) {
                        skipped.push(json!({ "name": name, "reason": e }));
                        continue;
                    }
                    briefs.push(brief(&spec));
                    imported.push(spec.name.clone());
                    servers.push(spec);
                }
                Some(c) => skipped.push(json!({
                    "name": name,
                    "reason": c.status.reason(),
                })),
                // 扫描与导入之间源文件被改了。不静默忽略——用户勾了三条只进去两条得有个交代。
                None => skipped.push(json!({
                    "name": name,
                    "reason": "重新扫描时已找不到这条（源配置可能刚被改过）。",
                })),
            }
        }
        Ok((briefs, imported, skipped))
    })
    .await?;

    // 🔴 审计写在**落盘成功之后**。写在前面的话，`mutate` 失败时一条都没存，
    // 而 audit.log 里已经留下 N 条 `success=true` 的导入记录。
    for b in briefs {
        audit_change(state, "mcp_bridge_import", b, None);
    }
    Ok(json!({ "imported": imported, "skipped": skipped }))
}

/// 新增或修改一条。
///
/// **不碰 `enabled`**：新增恒为 `false`，已有的保持原值。
/// 启用只有 `mcp_bridge_set_enabled` 一条路，否则总有一条会忘了写审计。
#[tauri::command]
pub async fn mcp_bridge_upsert(
    state: State<'_, Arc<AppState>>,
    server: ServerInput,
) -> Result<(), String> {
    let state = state.inner();
    // 三道校验只看 name / transport / command，不需要旧值，因此能先跑——
    // 好处是校验失败时还能带着完整摘要写审计（进了闭包就拿不到了）。
    let probe = ExternalMcpServer {
        name: server.name.clone(),
        transport: server.transport.clone().unwrap_or_else(|| "stdio".into()),
        command: server.command.clone(),
        args: server.args.clone(),
        env: server.env.clone().unwrap_or_default(),
        cwd: server.cwd.clone(),
        enabled: false,
        allow_remote_cwd: false,
    };
    if let Err(e) = validate(&probe) {
        audit_change(state, "mcp_bridge_upsert", brief(&probe), Some(e.clone()));
        return Err(e);
    }

    let (spec, changed) = mutate(state, move |servers| {
        let old = servers.iter().find(|s| s.name == server.name).cloned();
        let spec = ExternalMcpServer {
            name: server.name.clone(),
            transport: server.transport.unwrap_or_else(|| "stdio".into()),
            command: server.command,
            args: server.args,
            // 没传 = 沿用旧的（新增时旧的就是空）。
            env: server
                .env
                .unwrap_or_else(|| old.as_ref().map(|o| o.env.clone()).unwrap_or_default()),
            cwd: server.cwd,
            enabled: old.as_ref().map(|o| o.enabled).unwrap_or(false),
            // 同 `enabled`：沿用旧值。写死 false 的话，用户每改一次启动参数
            // 就会把这个开关悄悄关掉——而他并没打算动它。
            allow_remote_cwd: old.as_ref().map(|o| o.allow_remote_cwd).unwrap_or(false),
        };
        // 启动参数变了就得断掉旧进程，否则界面上写着新命令、实际跑的还是旧的。
        let changed = old.as_ref().map(|o| o.fingerprint()) != Some(spec.fingerprint());
        match servers.iter_mut().find(|s| s.name == spec.name) {
            Some(slot) => *slot = spec.clone(),
            None => servers.push(spec.clone()),
        }
        Ok((spec, changed))
    })
    .await?;

    if changed {
        state.mcp_bridge.drop_server(&spec.name);
        // 旧的失败记录是对旧命令的，不清的话那行会一直挂着一条已经修好的错误。
        state.mcp_bridge.clear_failures(&spec.name);
        // manifest 是按指纹判新旧的，不删也会自动变 stale；留着反而能告诉用户
        // 「上次拓到的是什么」，所以这里只断连接、不删缓存。
    }
    audit_change(state, "mcp_bridge_upsert", brief(&spec), None);
    Ok(())
}

/// 删一条。顺手断连接并删掉它的 manifest 缓存。
#[tauri::command]
pub async fn mcp_bridge_remove(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<(), String> {
    let state = state.inner();
    let n = name.clone();
    let removed = mutate(state, move |servers| {
        let Some(pos) = servers.iter().position(|s| s.name == n) else {
            return Err(format!("没有叫 `{n}` 的外挂 server。"));
        };
        Ok(servers.remove(pos))
    })
    .await?;

    state.mcp_bridge.drop_server(&name);
    state.mcp_bridge.clear_failures(&name);
    {
        let db = state.db.lock().await;
        let _ = manifest::delete(&db, &name);
    }
    audit_change(state, "mcp_bridge_remove", brief(&removed), None);
    Ok(())
}

/// 启用 / 停用一条。
///
/// 🔴 这是本模块风险最高的一个命令：打开就等于把这个 server 的全部能力交给远程，
/// 而 cc-bridge 的路径白名单**管不着它**。二次确认在前端（同 `ShellRiskModal` 那级），
/// 后端这里只负责重校一遍并落审计。
#[tauri::command]
pub async fn mcp_bridge_set_enabled(
    state: State<'_, Arc<AppState>>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner();
    let n = name.clone();
    let brief_v = mutate(state, move |servers| {
        let Some(slot) = servers.iter_mut().find(|s| s.name == n) else {
            return Err(format!("没有叫 `{n}` 的外挂 server。"));
        };
        // 启用时重跑一遍三道校验：配置可能是早先存下的，而磁盘上的东西会变
        // （比如那个命令现在才指向了 cc-bridge 自己）。放在临界区内才没有 TOCTOU 窗口。
        if enabled {
            validate(slot)?;
        }
        slot.enabled = enabled;
        Ok(brief(slot))
    })
    .await?;

    if !enabled {
        // 不断的话：开关已经拨回去了，子进程还在跑。
        state.mcp_bridge.drop_server(&name);
    }
    let mut params = brief_v;
    params["enabled"] = json!(enabled);
    audit_change(state, "mcp_bridge_set_enabled", params, None);
    Ok(())
}

/// 开 / 关某个 server 的「允许远程指定工作目录」。
///
/// 🔴 这是本特性里**唯一放宽边界**的开关：关着时 cwd 由本机管理员定死，
/// 开了之后由远程在白名单根目录内挑。对于**不接受路径参数、只从 cwd 解析**的
/// server，这道边界原本是硬的——所以二次确认与审计都不能省。
///
/// 关掉时把该 server 的全部会话摘掉：那些用远程指定目录起来的进程，
/// 是在一个**现已撤销**的授权下启动的，不该继续留着。
#[tauri::command]
pub async fn mcp_bridge_set_remote_cwd(
    state: State<'_, Arc<AppState>>,
    name: String,
    allowed: bool,
) -> Result<(), String> {
    let state = state.inner();
    let n = name.clone();
    let brief_v = mutate(state, move |servers| {
        let Some(slot) = servers.iter_mut().find(|s| s.name == n) else {
            return Err(format!("没有叫 `{n}` 的外挂 server。"));
        };
        slot.allow_remote_cwd = allowed;
        Ok(brief(slot))
    })
    .await?;

    if !allowed {
        state.mcp_bridge.drop_server(&name);
    }
    let mut params = brief_v;
    params["allowRemoteCwd"] = json!(allowed);
    audit_change(state, "mcp_bridge_set_remote_cwd", params, None);
    Ok(())
}

/// 总开关。关掉时把所有子进程一并停了。
#[tauri::command]
pub async fn mcp_bridge_set_master(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner();
    {
        let db = state.db.lock().await;
        let mut cfg = state.config.write().await;
        save_config_field(&db, KEY_ENABLED, &json!(enabled))?;
        cfg.external_mcp_enabled = enabled;
    }
    if !enabled {
        state.mcp_bridge.shutdown_all();
    }
    audit_change(
        state,
        "mcp_bridge_set_master",
        json!({ "enabled": enabled }),
        None,
    );
    Ok(())
}

/// 探测：拉起来、把工具清单拓下来、**再关掉**。
///
/// 🔴 本模块唯一会启动子进程的命令，必须由用户显式点。
/// 用完就关（不进连接池）：点一下「探测」就留下一个常驻进程是个意外。
#[tauri::command]
pub async fn mcp_bridge_probe(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<BridgeProbeResult, String> {
    let state = state.inner();
    let (master, spec) = {
        let cfg = state.config.read().await;
        (
            cfg.external_mcp_enabled,
            cfg.external_mcp_servers
                .iter()
                .find(|s| s.name == name)
                .cloned(),
        )
    };
    if !master {
        // 总开关的语义就是「允许启动外挂进程」，探测也不例外。
        return Err("外挂 MCP 桥总开关未启用，探测会真的启动子进程，故不允许。".into());
    }
    let spec = spec.ok_or_else(|| format!("没有叫 `{name}` 的外挂 server。"))?;
    validate(&spec)?;

    let probing = spec.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        // 探测走配置里的 cwd（None = 让 connect 用 spec.cwd），不接受远程指定。
        let mut s = session::connect(&probing, None, bridge::DEFAULT_TIMEOUT)?;
        let now = chrono::Local::now().timestamp();
        let captured = manifest::capture(s.client()?, &probing, bridge::DEFAULT_TIMEOUT, now);
        let tail = s.stderr_tail();
        s.shutdown(session::GRACE);
        match captured {
            Ok(m) => Ok(m),
            // 真正的原因往往只在对方的 stderr 里。
            Err(e) if tail.is_empty() => Err(e),
            Err(e) => Err(format!("{e}\nstderr：\n{}", tail.join("\n"))),
        }
    })
    .await
    .map_err(|e| format!("探测任务 panic：{e}"))?;

    match outcome {
        Ok(m) => {
            let count = m.tool_count();
            {
                let db = state.db.lock().await;
                manifest::save(&db, &m)?;
            }
            // 探测不走连接池（探完就关），所以失败记录得手动维护。
            // 不清的话：用户改好命令、探测成功了，那行仍旧显示上一次的失败原文。
            state.mcp_bridge.clear_failures(&name);
            audit_change(
                state,
                "mcp_bridge_probe",
                json!({ "name": name, "toolCount": count }),
                None,
            );
            Ok(BridgeProbeResult {
                state: "ready".into(),
                tool_count: count,
                error: None,
            })
        }
        // 失败也返 `Ok`：要让那一行就地显示错误原文，而不是弹个 toast 就没了。
        Err(e) => {
            // 记下来，否则列表一刷新那行就变回「未探测」，刚看到的错误原文就没了。
            state.mcp_bridge.note_failure(&spec, None, &e);
            audit_change(
                state,
                "mcp_bridge_probe",
                json!({ "name": name }),
                Some(e.clone()),
            );
            Ok(BridgeProbeResult {
                state: "failed".into(),
                tool_count: 0,
                error: Some(e),
            })
        }
    }
}

/// 导入向导里的「运行一下」：把**还没导入**的候选拉起来拓一次工具清单，再关掉。
///
/// 🔴 它与 `mcp_bridge_probe` 并列为本模块**仅有的两个会启动子进程的命令**，
/// 同样必须由用户显式点。区别只在于：probe 的对象在配置里，inspect 的对象还不在。
///
/// **没有二次确认框**（列表行里已经逐字展示了完整命令），所以两件事不能省：
/// ① 按钮文案直说是“运行”；② **本次执行进审计**——否则日志里会出现一个
/// 没有任何来源记录的进程启动。
///
/// 结果直接写进 `mcp_manifest`：用户随后导入时，设置页天然就有数据，
/// 不需要对同一个 server 再探一次。没导入就成孤儿行，由 `purge_orphans` 兜底。
#[tauri::command]
pub async fn mcp_bridge_inspect(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<BridgeInspectResult, String> {
    let state = state.inner();
    let (master, existing) = {
        let cfg = state.config.read().await;
        (
            cfg.external_mcp_enabled,
            cfg.external_mcp_servers.clone(),
        )
    };
    if !master {
        // 与 probe 同一条规矩：总开关的语义就是「允许启动外挂进程」。
        return Err("外挂 MCP 桥总开关未启用，运行候选会真的启动子进程，故不允许。".into());
    }

    // 重新扫一遍而不相信前端传回来的 spec：与 `mcp_bridge_import` 同理——
    // 前端拿到的预览**没有 env 值**（S7），而启动真需要它。
    let (mut cands, _) = scan_sources();
    import::mark_self(&mut cands);
    import::mark_already_imported(&mut cands, &existing);
    let taken: Vec<String> = existing.iter().map(|s| s.name.clone()).collect();
    import::resolve_names(&mut cands, &taken);

    let cand = cands
        .iter()
        .find(|c| c.spec.name == name)
        .ok_or_else(|| format!("重新扫描时已找不到 `{name}`（源配置可能刚被改过）。"))?;
    if cand.status != import::CandidateStatus::Importable {
        return Err(format!("`{name}` 不可导入：{}", cand.status.reason()));
    }
    let spec = cand.spec.clone();
    validate(&spec)?;

    let running = spec.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let mut s = session::connect(&running, None, bridge::DEFAULT_TIMEOUT)?;
        let now = chrono::Local::now().timestamp();
        let captured = manifest::capture(s.client()?, &running, bridge::DEFAULT_TIMEOUT, now);
        let tail = s.stderr_tail();
        s.shutdown(session::GRACE);
        match captured {
            Ok(m) => Ok(m),
            Err(e) if tail.is_empty() => Err(e),
            Err(e) => Err(format!("{e}\nstderr：\n{}", tail.join("\n"))),
        }
    })
    .await
    .map_err(|e| format!("运行任务 panic：{e}"))?;

    // 审计带上完整命令：没有确认框时，这里是唯一能回答
    // 「这个进程当时为什么被启动」的地方。`brief()` 只出 env 键名（S7）。
    match outcome {
        Ok(m) => {
            let count = m.tool_count();
            let tools = manifest::compact_index(&m.tools);
            let instructions = m.instructions.clone();
            {
                let db = state.db.lock().await;
                manifest::save(&db, &m)?;
            }
            audit_change(state, "mcp_bridge_inspect", brief(&spec), None);
            Ok(BridgeInspectResult {
                state: "ready".into(),
                tool_count: count,
                tools,
                instructions,
                error: None,
            })
        }
        // 失败也返 `Ok`：要让那一行就地显示错误原文，而不是弹个 toast 就没了。
        Err(e) => {
            audit_change(state, "mcp_bridge_inspect", brief(&spec), Some(e.clone()));
            Ok(BridgeInspectResult {
                state: "failed".into(),
                tool_count: 0,
                tools: Value::Array(vec![]),
                instructions: None,
                error: Some(e),
            })
        }
    }
}

/// 扫描各个已知位置。读不到 / 解不开的**静默跳过**：
/// 用户没装 Cursor 不是错误，不该报给他看。
fn scan_sources() -> (Vec<import::ImportCandidate>, Vec<String>) {
    let mut out = Vec::new();
    let mut hit = Vec::new();

    let home = home_dir();
    let mut try_one = |path: Option<PathBuf>, label: &str, claude_code: bool| {
        let Some(p) = path else { return };
        let Ok(text) = std::fs::read_to_string(&p) else {
            return;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            log::warn!("{label} 不是合法 JSON，已跳过");
            return;
        };
        let found = if claude_code {
            import::parse_claude_code(&v, label)
        } else {
            import::parse_flat(&v, label)
        };
        if !found.is_empty() {
            hit.push(label.to_string());
        }
        out.extend(found);
    };

    try_one(
        home.as_ref().map(|h| h.join(".claude.json")),
        "~/.claude.json",
        true,
    );
    try_one(
        home.as_ref().map(|h| h.join(".cursor").join("mcp.json")),
        "~/.cursor/mcp.json",
        false,
    );
    try_one(
        claude_desktop_config(home.as_ref()),
        "Claude Desktop",
        false,
    );

    (out, hit)
}

/// 家目录。不引 `dirs` crate——为一个函数加依赖不值（规则 8），
/// 而且项目里 `shell.rs` / `system.rs` 已经是这个写法。
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Claude Desktop 的配置位置因平台而异。
fn claude_desktop_config(home: Option<&PathBuf>) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let _ = home;
        std::env::var_os("APPDATA").map(|a| {
            PathBuf::from(a)
                .join("Claude")
                .join("claude_desktop_config.json")
        })
    }
    #[cfg(not(windows))]
    {
        home.map(|h| {
            h.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, transport: &str, command: &str) -> ExternalMcpServer {
        ExternalMcpServer {
            name: name.into(),
            transport: transport.into(),
            command: command.into(),
            args: vec![],
            env: vec![],
            cwd: None,
            enabled: false,
            allow_remote_cwd: false,
        }
    }

    /// 命令不存在**不是**拒绝理由：用户可能先配好再装那个程序。
    /// 它在列表里会显示为 `not_installed`，但不阻止保存。
    #[test]
    fn accepts_stdio_with_unknown_command() {
        assert!(validate(&spec("ok", "stdio", "definitely-not-on-this-path-xyz")).is_ok());
    }

    /// 非 stdio 直接拒，**不静默存下来等运行时才报错**。
    #[test]
    fn rejects_non_stdio() {
        let e = validate(&spec("ok", "http", "x")).expect_err("http 应被拒");
        assert!(e.contains("stdio"), "错误得说清楚只支持 stdio：{e}");
    }

    #[test]
    fn rejects_empty_command() {
        assert!(validate(&spec("ok", "stdio", "   ")).is_err());
    }

    #[test]
    fn rejects_bad_name() {
        assert!(validate(&spec("Bad Name", "stdio", "x")).is_err());
    }

    /// 🔴 S8：指向 cc-bridge 自己的必须在**保存时**就被拦下——
    /// 导入向导会滤一次，但用户完全可以绕过它手动添加。
    /// 判定靠路径不靠名字：这里故意取了一个不相干的名字。
    #[test]
    fn rejects_self_reference_by_path() {
        let Ok(me) = std::env::current_exe() else {
            return; // 拿不到自身路径就跳过，不制造假失败
        };
        let s = spec("totally-unrelated", "stdio", &me.to_string_lossy());
        let e = validate(&s).expect_err("指向自身的必须被拒");
        assert!(e.contains("cc-bridge 自己"), "错误得说明原因：{e}");
    }

    /// 审计摘要里**绝不能出现 env 值**（S7）。审计日志是落盘的。
    #[test]
    fn brief_never_leaks_env_values() {
        let mut s = spec("x", "stdio", "x");
        s.env = vec![("API_KEY".into(), "sk-live-super-secret".into())];
        let text = brief(&s).to_string();
        assert!(text.contains("API_KEY"), "键名该出现：{text}");
        assert!(!text.contains("sk-live"), "值泄露了：{text}");
    }
}
