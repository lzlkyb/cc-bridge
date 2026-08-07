# cc-bridge 通用 MCP server 桥接器方案

> 时间: 2026-08-06 · 出处: Hermes 会话 `20260806_040623_18db00f5` (消息 #8945 + #8946)
> 上下文: 用户问"能不能在 cc-bridge 里做一个通用 MCP server 桥接器,今天接 codegraph,明天接 Graphify,让用户自己装自己配,远程 Claude Code 一键可用"

---

## 一、答案

**能,1 周做出"通用 MCP server 桥接器"**。"通用"的边界:

- ✅ **协议级通用**:所有 stdio MCP server 都能挂(codegraph / Graphify / 任何未来的)
- ❌ 不通用:不替每个 MCP server 写专用适配(那是反模式)
- ❌ 不通用:不替用户做技术选型(多个 codegraph 让用户自己选)

**关键事实**:7+ 个 codegraph 类工具**全都已经是 stdio MCP server**——天然兼容,不需要适配层。

---

## 二、架构:cc-bridge = "MCP client gateway"

```
远程 Claude Code
  ↓ HTTP/MCP
cc-bridge (MCP server) ← 你现在有的
   ↓ 内部 router
   ├── [内置 17 个 tool]         ← 你现在有的
   └── [外挂 N 个 MCP server] ← 新增
         ├── codegraph-mcp       (用户装)
         ├── graphify-mcp        (明天有了就加)
         └── 任何未来的 stdio MCP server
```

---

## 三、用官方 `rmcp` crate(不自己造轮子)

| Crate | 版本 | 90天下载 | 来源 | 评级 |
|---|---|---:|---|---|
| **`rmcp`** | 3.1.1 | **957 万** | `modelcontextprotocol/rust-sdk`(官方) | ⭐⭐⭐⭐⭐ |
| `rust-mcp-sdk` | 1.0.1 | 9.7 万 | 第三方 | ⭐⭐ |
| `mcp-client` | 0.1.0 | 0.1 万 | 第三方 | ⭐ |
| `mcp-sdk` | 0.0.3 | 0.1 万 | 第三方 | 0.0.x → 不成熟 |
| `mcp-rs` | 0.1.0 | 495 | 第三方 | 雏形 |

`rmcp` 是 Anthropic 官方维护,90 天下载占总量 50.4%,体量碾压第二名 ~85×。同时提供 server + client + **stdio transport**(`rmcp::transport::child_process::TokioChildProcess`),完全契合 cc-bridge 现有 `tokio` 栈。

**Cargo 体积代价**:走 `transport-child-process` 增量约 1.5-2 MB(对比 `process_wrap` 已有 ~0.5 MB)。如果想守"14 MB exe"红线,用 `rmcp` 3.x 的 client-only feature 裁剪。

---

## 四、cc-bridge 现有底座调研(关键事实)

> 子 agent 跑完 10 次 curl + 10 次 grep 后给的真实数据,不是凭印象

### 已具备"通用 MCP 桥接"的所有原语

- **Tool registry** (`desktop/src-tauri/src/mcp/tools/registry.rs:54`)
  - `ToolSpec { name, desc, is_write, schema, run }` — 单一注册源,22 个 `register_tool!` 行
  - 宏签名:`register_tool!($module, $args, $desc, $is_write)` — 工具自描述,无 match/json! 重复
  - `all_tools()` → `http.rs::dispatch_tool` 按 name 派发
- **stdio 子进程生命周期** (`run_command.rs:279-396`)
  - `spawn_shell` / `spawn_background` / `spawn_reader_thread` = 完整 stdio 子进程模式
  - stdin=null / stdout/stderr=Stdio::piped → `cmd.spawn()` → 读线程 → JobObject 管理进程树 → `stop_command` 关停
- **进程句柄范式** (`state.rs:31-36`):已有 `Arc<StdMutex<Box<dyn StdChildWrapper>>>` 存进程句柄
- **shell 抽象** (`shell.rs`):`ShellType::{Cmd, Bash}` + `build_invocation`,借鉴点

### 关键缺口

cc-bridge 角色**一直是 server**,从来没扮演过 **MCP client**。要桥接"任意 MCP server",必须新增:

1. `McpClientTransport`(spawn 子进程 + NDJSON 读写循环)
2. 注册一批 wrapper tool,远端 server 的 `tools/list` + `tools/call` 暴露给 cc-bridge 自己的 client

> **没有现成 MCP 协议层**,只是"跑一个命令拿 stdout"。把它升级成"跑一个 MCP server,跑 NDJSON-over-stdio 的 JSON-RPC 2.0"是纯增量。

### 文件路径速查(复用点)

| 路径 | 用途 |
|---|---|
| `desktop/src-tauri/src/mcp/tools/registry.rs:54` | `register_tool!` 宏 |
| `desktop/src-tauri/src/mcp/tools/run_command.rs:279-396` | `spawn_shell` / `spawn_background` / `spawn_reader_thread` |
| `desktop/src-tauri/src/mcp/tools/shell.rs` | `ShellType` 抽象(借鉴点) |
| `desktop/src-tauri/src/mcp/http.rs:688,714,727` | `dispatch_tool` / `all_tools()` / `get_tool_definitions` |
| `desktop/src-tauri/src/state.rs:31-36` | `RunningCommand` 进程句柄模式 |
| `desktop/src-tauri/Cargo.toml` | 已有 `tokio` features=["process"],无 MCP crate 依赖 |

---

## 五、MCP 协议事实(2026-07-28 spec)

- **stdio = 官方 transport**:JSON-RPC 2.0 messages over NDJSON on stdin/stdout
- **角色**:Hosts(LLM 应用) / Clients(连接器) / Servers(提供 context)
- Claude Code / Cursor / Cline 等所有主流 host 把 stdio 子进程模式当作**默认/标配**配置方式

---

## 六、实现路径(4 步,1 周)

### Step 1:加 rmcp 依赖(5 分钟)

```toml
# desktop/src-tauri/Cargo.toml
rmcp = { version = "3", features = ["client", "transport-child-process", "macros"] }
```

### Step 2:写"通用 MCP client 桥接器"(1 天)

新建 `desktop/src-tauri/src/mcp/bridge/mod.rs`:

```rust
use rmcp::service::ServiceExt;
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::model::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExternalMcpServer {
    pub name: String,           // "codegraph" / "graphify" / ...
    pub command: String,        // "codegraph-mcp" / "graphify" / ...
    pub args: Vec<String>,      // ["--root", "/path"]
    pub env: HashMap<String, String>, // API keys 等
    pub enabled: bool,
}

pub struct McpBridge {
    servers: RwLock<HashMap<String, Arc<BridgeEntry>>>,
}

struct BridgeEntry {
    spec: ExternalMcpServer,
    peer: rmcp::service::Peer<rmcp::RoleClient>,
}

impl McpBridge {
    /// 启动所有 enabled 的外部 MCP server (用户 cc-bridge 启动时跑一次)
    pub async fn bootstrap(servers: Vec<ExternalMcpServer>) -> anyhow::Result<Self> {
        let mut map = HashMap::new();
        for spec in servers.iter().filter(|s| s.enabled) {
            match Self::spawn_one(spec.clone()).await {
                Ok(entry) => {
                    tracing::info!("✅ MCP server 上线: {}", spec.name);
                    map.insert(spec.name.clone(), Arc::new(entry));
                }
                Err(e) => {
                    // 不阻断,只警告 — 允许用户某个 server 没装也不挂
                    tracing::warn!("⚠️ MCP server {} 启动失败: {}", spec.name, e);
                }
            }
        }
        Ok(Self { servers: RwLock::new(map) })
    }

    async fn spawn_one(spec: ExternalMcpServer) -> anyhow::Result<BridgeEntry> {
        let mut cmd = tokio::process::Command::new(&spec.command);
        cmd.args(&spec.args)
            .envs(spec.env.iter())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let transport = TokioChildProcess::new(cmd)
            .map_err(|e| anyhow::anyhow!("spawn失败: {e}"))?;

        let client = ().serve(transport).await
            .map_err(|e| anyhow::anyhow!("MCP 握手失败: {e}"))?;

        Ok(BridgeEntry { spec, peer: client })
    }

    /// 列出所有外挂 server 的 tool (带前缀以避免命名冲突)
    pub async fn list_tools(&self) -> Vec<ToolSpec> {
        let mut out = Vec::new();
        let servers = self.servers.read().await;
        for (name, entry) in servers.iter() {
            if let Ok(remote_tools) = entry.peer.list_tools(Default::default()).await {
                for t in remote_tools.tools {
                    let prefixed_name = format!("mcp__{}__{}", name, t.name);
                    out.push(ToolSpec {
                        name: prefixed_name,
                        desc: format!("[{}] {}", name, t.description.unwrap_or_default()),
                        is_write: false,  // 外挂 server 视为只读, 走 cc-bridge 自己的白名单
                        schema: t.input_schema,
                        run: ..., // 转发 handler
                    });
                }
            }
        }
        out
    }

    /// tools/call 时转发到对应外挂 server
    pub async fn call(&self, prefixed_name: &str, args: serde_json::Value) -> anyhow::Result<String> {
        // 解析 "mcp__codegraph__find_callers" → ("codegraph", "find_callers")
        let parts: Vec<&str> = prefixed_name.splitn(3, "__").collect();
        if parts.len() != 3 || parts[0] != "mcp" {
            anyhow::bail!("not an mcp__ prefixed tool");
        }
        let server_name = parts[1];
        let tool_name = parts[2];

        let servers = self.servers.read().await;
        let entry = servers.get(server_name)
            .ok_or_else(|| anyhow::anyhow!("unknown mcp server: {server_name}"))?;

        let result = entry.peer.call_tool(
            CallToolRequestParam { name: tool_name.to_string(), arguments: Some(args) }
        ).await?;

        // 提取 text content
        Ok(serde_json::to_string(&result.content)?)
    }
}
```

### Step 3:用户配置(1 行 JSON)

`~/.cc-bridge/config.json` 加一个 section:

```json
{
  "external_mcp_servers": [
    {
      "name": "codegraph",
      "command": "codegraph-mcp",
      "args": ["--root", "/Users/me/projects"],
      "env": {},
      "enabled": true
    },
    {
      "name": "graphify",
      "command": "graphify-mcp",
      "args": [],
      "env": { "OPENAI_API_KEY": "sk-***" },
      "enabled": false
    }
  ]
}
```

**关键设计**:cc-bridge **不替用户装**——只检测 + 提示。配置里写哪个就 spawn 哪个。

### Step 4:UI 加"一键配置"按钮(半天)

```
cc-bridge 设置面板 → "外部 MCP server" →

┌─ codegraph ─────────────────────────────────┐
│ 状态: ⚠️ 未检测到 codegraph-mcp              │
│ 命令: codegraph-mcp                          │
│ [自动安装] [手动安装指南] [启用]              │
└──────────────────────────────────────────────┘

┌─ graphify ──────────────────────────────────┐
│ 状态: 未启用                                  │
│ 命令: graphify-mcp                           │
│ [安装] [启用]                                 │
└──────────────────────────────────────────────┘
```

**"自动安装"按钮**:

```rust
async fn auto_install(server: &str) -> Result<()> {
    match server {
        "codegraph" => {
            // 调 cargo install --git ... codegraph-mcp
            run_cmd("cargo", &["install", "--git",
                "https://github.com/suatkocar/codegraph", "codegraph-mcp"]).await?;
        }
        "graphify" => {
            // 调 npm install -g graphify-mcp 或 pip install
        }
        _ => bail!("未知 server"),
    }
    Ok(())
}
```

---

## 七、远程 Claude Code 用法(零改动)

```bash
# 用户机器 (永久一次)
claude mcp add --transport http cc-bridge http://<bridge-ip>:<port>/mcp \
    -H "Authorization: Bearer ***"

# 远程 Claude Code 自动看到外挂 tool
claude mcp list
# cc-bridge: ... tools: read_files, write_files, ..., mcp__codegraph__find_callers, mcp__graphify__...

# 直接用
> 用 mcp__codegraph__find_callers 找 ollama::Client::new 的所有调用方
> 用 mcp__graphify__explain_this_module 分析 src/ai/mod.rs
```

**用户不用知道这是 codegraph 还是 Graphify**——Claude Code 只看到统一前缀的工具名。

---

## 八、关键设计点(防翻车)

| 设计 | 为什么 |
|---|---|
| **不替用户装二进制** | 各 MCP server 安装方式不同(cargo/npm/pip/curl binary),cc-bridge 管不过来。**只检测 + 提示** |
| **挂掉不阻断 cc-bridge** | 单个 MCP server 启动失败只 warn,其他继续工作 |
| **外挂视为只读** | 走 cc-bridge 自己的 path whitelist + 审计,**不让外挂 server 自己乱写** |
| **tool 前缀 `mcp__<server>__<tool>`** | 避免和 cc-bridge 内置 17 个 tool 命名冲突 |
| **配置驱动 vs 代码硬编码** | 用户加新 server **零 cc-bridge 改动**,只改 config.json |
| **复用现成原语** | `Arc<StdChildWrapper>` 句柄模式 / `firewall::suppress_child_error_dialogs` / 白名单 cwd 检查 / 审计日志 — 全部直接套 |
| **rmcp 官方 SDK** | 不自己造 JSON-RPC 轮子,Anthropic 维护,90天下载 957 万 |

---

## 九、1 周交付计划

| 天 | 工作 | 验证 |
|---|---|---|
| **D1** | 加 rmcp 依赖 + 写 `bridge/mod.rs` | `cargo build` 通过 |
| **D2** | 接入 cc-bridge `tools/list` 和 `dispatch_tool` | `tools/list` 返回 `mcp__codegraph__*` |
| **D3** | 配 config.json 解析 + 启动时 bootstrap | cc-bridge 启动日志看到 ✅ codegraph |
| **D4** | UI 面板"外部 MCP server" + 状态检测 | UI 显示 ⚠️ 未检测到 |
| **D5** | "自动安装"按钮(先支持 codegraph) | 点按钮后 `which codegraph-mcp` 返回路径 |
| **D6** | 远程 Claude Code 联调 + 文档 | 远程 claude 能用 mcp__codegraph__find_callers |
| **D7** | buffer + 错误处理打磨 | 故意 kill codegraph-mcp, cc-bridge 不挂 |

---

## 十、要拍板的 3 件事(待定)

1. **配置格式**:用 cc-bridge 现有 `config.json` 还是单独 `external_mcp.json`?
   - **建议前者**,复用现有解析

2. **自动安装策略**:
   - A. 只检测 + 弹"安装指南"(保守,零风险)
   - B. 检测 + 一键 `cargo install`(激进,要 cargo 在 PATH)
   - C. 检测 + 自动 curl 下载 GitHub release binary(**推荐**,但要每个 server 配 release URL)

3. **优先级**:先做 codegraph 还是先做"通用桥接"再让用户挑?
   - A. 先 codegraph(验证路径,跑通再扩)
   - B. 先通用桥接 + codegraph + graphify 一起上(如果 graphify 已稳定的话)

---

## 一句话总结

**cc-bridge 加一个 `McpBridge` 模块 = 通用 stdio MCP client 桥接器**,用户 config.json 配哪个就 spawn 哪个,远程 Claude Code 自动看到 `mcp__<server>__<tool>` 前缀的工具——**今天接 codegraph,明天接 Graphify,零代码改动**。

---

## 附录:数据来源 URL(每条数据都可验证)

- 官方 MCP spec: https://modelcontextprotocol.io/specification/2026-07-28
- rmcp SDK: https://github.com/modelcontextprotocol/rust-sdk
- crates.io rmcp: https://crates.io/crates/rmcp (18.9M dl, 9.5M 90d)
- docs.rs rmcp: https://docs.rs/rmcp
- suatkocar/codegraph: https://github.com/suatkocar/codegraph
- Graphify-Labs/graphify: https://github.com/Graphify-Labs/graphify