//! CC 对话协议：把 CLI 的 NDJSON 一行翻成归一化事件。
//!
//! ## 形状来源（不是猜的）
//!
//! - 生产实现 `zhukunpenglinyutong/desktop-cc-gui` 的 `engine/claude.rs` 解析分支
//!   与 `engine/testdata/*.jsonl` 三份真实录制样本（`system/init`、`stream_event`、
//!   `result/success`、`background_tasks_changed`、`task_*`）。
//! - `docs/ClaudeCode客户端开源项目调研-2026-10-24.md` §4.3 的 13 个控制子类型。
//! - `docs/desktop-cc-gui源码分析-2026-10-24.md` §四 已踩过的七个坑。
//!
//! ## 🔴 两处必须真机复核的假设
//!
//! 1. **`allow` 的 `control_response` 带 `updatedInput`**：上游只实现了 deny 分支
//!    （`reader.rs:700-720`），allow 的形状取自协议文档的对称性。写错的表现是
//!    审批卡永远转圈（CLI 侧无限阻塞），兜底放在 `runner.rs` 的审批回执超时。
//! 2. **`--permission-prompt-tool stdio` 在 `--permission-mode default` 下真的上线
//!    `can_use_tool`**：上游那个 Bash 测试夹具是手写的，只证明解析分支存在。
//!
//! ## 为什么前端只认这里的枚举
//!
//! CLI 的原始形状随版本漂移（`system` 子类型每年都在加），归一化必须放在 Rust 侧：
//! 前端只加渲染分支、不碰字段名。见源码分析 §一.1「前端几乎零引擎分支」。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 归一化后的对话事件。前端 reducer 只认这个。
///
/// `rename_all_fields` 让变体字段输出 camelCase，与 Tauri 命令参数的既有约定一致。
///
/// 🔴 `Deserialize` 是**落盘回放**用的（`store.rs` 把事件存成 JSON 再读回）。
/// 它必须与 `Serialize` 共用同一套 rename，否则存进去的 `camelCase` 字段
/// 反序列化时按 `snake_case` 找不到 —— 表现是恢复出来的会话只剩用户消息，
/// 助手正文和工具卡全空，而且没有任何报错（`store.rs` 那边是 `.ok()` 兜底）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CcEvent {
    /// `system/init`：会话建立。这是唯一能拿到 CLI 真实 session_id 的地方，
    /// 下一轮 `--resume` 靠它续接。
    Init {
        session_id: String,
        cwd: Option<String>,
        model: Option<String>,
    },
    /// 用户自己的消息。**不来自 CLI**，但必须进事件流水：切页回来时前端靠重放
    /// 重建界面，本地消息若只活在 React 里就会凭空消失。
    UserMessage {
        text: String,
        /// 回显用的图片：**缩略图 data URL**（长边 256px、JPEG），不是原图。
        ///
        /// 🔴 原图只走 stdin 那一次，不落这里。原因有两层：原图 base64 动辄几 MB，
        ///    进事件流水会把 `MAX_EVENTS_BYTES`（4 MB）一两条就撑满，后面的对话
        ///    全被 `trim_events` 从头丢掉；而流水本身是要长期躺在 SQLite 里的。
        ///    代价是历史里点开只能看到缩略图 —— 这是明确取舍，见
        ///    `design/对话页-图片输入-设计稿-2026-10-26.html` 定案 6。
        ///
        /// `#[serde(default)]` + `skip_serializing_if` 是**老流水兼容**：2026-10-26
        /// 之前落盘的事件没有这个字段，缺了就整箱反序列化失败（`store.rs` 那边
        /// 是 `.ok()` 兜底），表现是整个会话恢复成空白。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
    /// 助手正文。`streaming=true` 是增量追加，`false` 是最终全文覆盖。
    ///
    /// 🔴 两者共用同一个 `block_id`（`{message_id}:{index}`），所以覆盖是安全的：
    /// 流式的碎片会被完整消息替换掉，不会重复两遍。
    Text {
        block_id: String,
        text: String,
        streaming: bool,
    },
    /// 思维链。渲染层可以折叠，但不能丢 —— 空等 30 秒比看到思考过程难受得多。
    Thinking {
        block_id: String,
        text: String,
        streaming: bool,
    },
    /// 工具调用（入参已解析成 JSON，不是碎片）。
    ToolUse {
        tool_use_id: String,
        name: String,
        input: Value,
    },
    /// 工具结果。`is_error` 决定卡片颜色，不能只靠文本判断。
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
    /// 需要用户批准。`request_id` 是回写 `control_response` 的唯一凭据。
    PermissionAsk {
        request_id: String,
        tool_name: String,
        input: Value,
        tool_use_id: Option<String>,
        /// 协议里的 `decision_reason`，原样展示 —— 用户要知道「为什么问我」。
        reason: Option<String>,
    },
    /// CLI 撤回了审批请求（超时或被打断）。界面必须把卡片落定，不能留着转圈。
    PermissionCancel { request_id: String },
    /// 用户已经决定了（本地事件，不来自 CLI）。
    ///
    /// 必须进流水：否则切页回来重放时这张卡会重新变回「等待批准」，
    /// 而它对应的进程早就不在了 —— 用户会反复点一个永远没反应的按钮。
    PermissionResolved {
        request_id: String,
        /// `"allow"` / `"deny"`。
        decision: String,
        /// `true` = 审批规则命中、系统**代替用户**放行的（不是用户点的）。
        ///
        /// 审计与界面靠它区分「谁做的决定」：自动放行的卡落定成
        /// 「已自动放行」，人工的落定成「已允许 / 已拒绝」。
        /// `#[serde(default)]` 让 2026-10-24 之前落盘的老流水读回来是 false
        ///（那条路本来就是人工的），不会反序列化失败被整箱丢掉。
        #[serde(default)]
        auto: bool,
    },
    /// `AskUserQuestion`：与审批同构，但语义是「选择」而不是「放行」。
    Question {
        request_id: String,
        tool_use_id: Option<String>,
        input: Value,
    },
    /// `system/api_retry`。🔴 不是错误：CLI 会退避 10 次、每次 30s+ 后继续，
    /// 渲染成「重试中 x/y」而不是红字报错。
    Retry {
        attempt: u64,
        max: u64,
        message: String,
    },
    /// `system/compact_boundary`：上下文刚被压缩。必须提示，否则用户不知道
    /// 为什么模型「忘了」前面的事。
    Compact { post_tokens: i64 },
    /// 后台任务数变化。>0 时说明 turn 结束后 CLI 还会自己再开一轮。
    BackgroundTasks { pending: usize },
    /// `result`：本轮结束。
    TurnEnd {
        session_id: Option<String>,
        is_error: bool,
        text: Option<String>,
        usage: Option<Value>,
        /// `result.modelUsage`：每个模型的累计用量与上下文窗口（探针 0-3 实测
        /// 每轮 `result` 都带，字段是 camelCase 且版本间还在加）。原样透传，
        /// 理由同 `usage`——前端只读其中几个，拆结构体等于每加一个键改一次 Rust。
        ///
        /// `#[serde(default)]`：2026-10-24 之前落盘的老流水没有这个字段，
        /// 读回 `None` 而不是反序列化失败被整箱丢掉（余量条 simply 不显示）。
        #[serde(default)]
        model_usage: Option<Value>,
        cost_usd: Option<f64>,
        num_turns: Option<u64>,
        duration_ms: Option<u64>,
    },
    /// CLI 写到 stderr 的内容（去重后的尾巴）。
    ///
    /// 不是协议解析产物，但必须走同一条事件通道：启动失败、模型名不对、认证过期
    /// 这些**只有 stderr 会说**，而 stdout 上只会静静地看着。
    Stderr { lines: Vec<String> },
    /// 进程退出。**每一轮都会收到**，是前端把「运行中」落定的唯一可靠信号 ——
    /// 不能只等 `TurnEnd`，因为崩溃、被 kill、CLI 直接退出都不会发 `result`。
    Exit { code: Option<i32> },
}

/// 跨行累积的 block（流式 `content_block_*` 三段式）。
enum BlockAcc {
    Text(String),
    Thinking(String),
    ToolUse {
        id: String,
        name: String,
        json: String,
    },
}

/// 解析器的跨行状态。**一轮一个进程**，所以这个状态只需要活一轮。
#[derive(Default)]
pub struct ProtoState {
    /// 当前流式消息 id（`message_start` 给）。拼 `block_id` 用。
    msg_id: Option<String>,
    /// `content_block.index` → 累积中的块。
    blocks: HashMap<u64, BlockAcc>,
    /// 完整快照事件使用的下一个 block 序号。
    ///
    /// 🔴 **必须跨 `assistant` 事件累加，不能每条都从 0 数**：中转站会把一条消息
    /// 拆成「thinking 一条、text 一条」两次 `assistant` 事件，两次的 `content`
    /// 各自从下标 0 开始；而流式那边的 `index` 是**全局连续**的（thinking=0、
    /// text=1）。照 content 下标直接拼 `block_id` 会把 text 写成 `id:0`，
    /// 而流式累积的 text 在 `id:1` —— 同一段话在界面上出现两遍。
    full_index_base: u64,
    /// 上一条完整快照属于哪条消息（换消息时把上一行清零）。
    full_msg_id: Option<String>,
}

impl ProtoState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 吃一行，吐出若干个事件。
    ///
    /// 坏行（非 JSON / 结构不符）**静默丢弃**：stdout 上偶尔会混进 CLI 的
    /// 进度提示或 BOM 残迹，为一行脏数据掐掉整轮会话不值得。
    pub fn feed(&mut self, line: &str) -> Vec<CcEvent> {
        let mut out = Vec::new();
        let trimmed = line.trim();
        // 有的版本会在行首带 BOM；`serde_json` 不认。
        let trimmed = trimmed.trim_start_matches('\u{feff}');
        if trimmed.is_empty() {
            return out;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            return out;
        };
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "system" => self.on_system(&value, &mut out),
            "stream_event" => self.on_stream_event(&value, &mut out),
            "assistant" => {
                // 完整消息快照：流式碎片到此收口，用全文覆盖。
                let message = value.get("message");
                let msg_id = message
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(blocks) = message
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    // 换了一条消息就重新从 0 开始数；同一条消息里的多次 assistant
                    // 事件则接着上一段往下数（见 `full_index_base` 的注释）。
                    if self.full_msg_id.as_deref() != Some(msg_id) {
                        self.full_msg_id = Some(msg_id.to_string());
                        self.full_index_base = 0;
                    }
                    let base = self.full_index_base;
                    for (index, block) in blocks.iter().enumerate() {
                        let block_id = format!("{msg_id}:{}", base + index as u64);
                        match block.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => out.push(CcEvent::Text {
                                block_id,
                                text: block
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                streaming: false,
                            }),
                            "thinking" => out.push(CcEvent::Thinking {
                                block_id,
                                text: block
                                    .get("thinking")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                streaming: false,
                            }),
                            "tool_use" => {
                                let tool_use_id = block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                if tool_use_id.is_empty() {
                                    continue;
                                }
                                out.push(CcEvent::ToolUse {
                                    tool_use_id,
                                    name: block
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string(),
                                    input: block.get("input").cloned().unwrap_or(Value::Null),
                                });
                            }
                            _ => {}
                        }
                    }
                    self.full_index_base = base + blocks.len() as u64;
                }
            }
            "user" => {
                // tool_result 走这里。注意它和 assistant 的 tool_use 是**分开的两条消息**。
                if let Some(blocks) = value
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in blocks {
                        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                            continue;
                        }
                        let tool_use_id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if tool_use_id.is_empty() {
                            continue;
                        }
                        out.push(CcEvent::ToolResult {
                            tool_use_id,
                            content: flatten_content(block.get("content")),
                            is_error: block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        });
                    }
                }
            }
            "result" => out.push(turn_end(&value)),
            "control_request" => self.on_control_request(&value, &mut out),
            "control_cancel_request" => {
                if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
                    out.push(CcEvent::PermissionCancel {
                        request_id: request_id.to_string(),
                    });
                }
            }
            _ => {}
        }
        out
    }

    fn on_system(&mut self, value: &Value, out: &mut Vec<CcEvent>) {
        let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
        match subtype {
            "init" => {
                let session_id = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if session_id.is_empty() {
                    return;
                }
                out.push(CcEvent::Init {
                    session_id,
                    cwd: value.get("cwd").and_then(Value::as_str).map(str::to_string),
                    model: value
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            }
            "api_retry" => {
                let attempt = value.get("attempt").and_then(Value::as_u64).unwrap_or(0);
                let max = value
                    .get("max_retries")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                out.push(CcEvent::Retry {
                    attempt,
                    max,
                    message: format_retry(value, attempt, max),
                });
            }
            "compact_boundary" => {
                let post = value
                    .get("compactMetadata")
                    .and_then(|m| m.get("postTokens").or_else(|| m.get("post_tokens")))
                    .and_then(Value::as_i64);
                if let Some(post_tokens) = post {
                    out.push(CcEvent::Compact { post_tokens });
                }
            }
            "background_tasks_changed" => {
                let pending = value
                    .get("tasks")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                out.push(CcEvent::BackgroundTasks { pending });
            }
            // `task_started` / `task_updated` / `task_notification` 属于后台任务细节，
            // 对话页只用 `background_tasks_changed` 的计数。其余子类型忽略：
            // CLI 每版都在加，白名单比黑名单安全。
            _ => {}
        }
    }

    fn on_stream_event(&mut self, value: &Value, out: &mut Vec<CcEvent>) {
        let Some(event) = value.get("event") else {
            return;
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                self.msg_id = event
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.blocks.clear();
                // 新消息 ⇒ 完整快照也从头数。
                self.full_index_base = 0;
                self.full_msg_id = self.msg_id.clone();
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let block = event.get("content_block");
                let kind = block
                    .and_then(|b| b.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match kind {
                    "text" => {
                        let text = block
                            .and_then(|b| b.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        self.blocks.insert(index, BlockAcc::Text(text));
                    }
                    "thinking" => {
                        let text = block
                            .and_then(|b| b.get("thinking"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        self.blocks.insert(index, BlockAcc::Thinking(text));
                    }
                    "tool_use" => {
                        let id = block
                            .and_then(|b| b.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .and_then(|b| b.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        self.blocks.insert(
                            index,
                            BlockAcc::ToolUse {
                                id,
                                name,
                                json: String::new(),
                            },
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let delta = event.get("delta");
                let Some(acc) = self.blocks.get_mut(&index) else {
                    return;
                };
                match (
                    delta.and_then(|d| d.get("type")).and_then(Value::as_str),
                    acc,
                ) {
                    (Some("text_delta"), BlockAcc::Text(buf)) => {
                        let chunk = delta
                            .and_then(|d| d.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        buf.push_str(chunk);
                        out.push(CcEvent::Text {
                            block_id: self.block_id(index),
                            text: chunk.to_string(),
                            streaming: true,
                        });
                    }
                    (Some("thinking_delta"), BlockAcc::Thinking(buf)) => {
                        let chunk = delta
                            .and_then(|d| d.get("thinking"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        buf.push_str(chunk);
                        out.push(CcEvent::Thinking {
                            block_id: self.block_id(index),
                            text: chunk.to_string(),
                            streaming: true,
                        });
                    }
                    (Some("input_json_delta"), BlockAcc::ToolUse { json, .. }) => {
                        if let Some(chunk) = delta
                            .and_then(|d| d.get("partial_json"))
                            .and_then(Value::as_str)
                        {
                            json.push_str(chunk);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                // tool_use 的入参到这里才拼完，一次性发出去 —— 前端不用自己拼碎片。
                if let Some(BlockAcc::ToolUse { id, name, json }) = self.blocks.remove(&index) {
                    if id.is_empty() {
                        return;
                    }
                    out.push(CcEvent::ToolUse {
                        tool_use_id: id,
                        name,
                        // 空串是合法的「无入参」，`null` 更像缺字段。
                        input: serde_json::from_str(&json)
                            .unwrap_or(Value::Object(Default::default())),
                    });
                }
            }
            _ => {}
        }
    }

    fn on_control_request(&mut self, value: &Value, out: &mut Vec<CcEvent>) {
        let request = value.get("request");
        let subtype = request
            .and_then(|r| r.get("subtype"))
            .and_then(Value::as_str)
            .unwrap_or("");
        // 只处理权限类。其余控制子类型（`initialize` / `interrupt` / `mcp_*` …）
        // 是 CLI 那边发起的管理动作，对话页不需要知道。
        if subtype != "can_use_tool" {
            return;
        }
        let Some(request_id) = value
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            // 没有 request_id 就无法回写 —— 宁可丢弃也不要让卡片永远转圈。
            return;
        };
        let tool_name = request
            .and_then(|r| r.get("tool_name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let input = request
            .and_then(|r| r.get("input"))
            .cloned()
            .unwrap_or(Value::Null);
        let tool_use_id = request
            .and_then(|r| r.get("tool_use_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if tool_name == "AskUserQuestion" {
            out.push(CcEvent::Question {
                request_id: request_id.to_string(),
                tool_use_id,
                input,
            });
        } else {
            out.push(CcEvent::PermissionAsk {
                request_id: request_id.to_string(),
                tool_name,
                input,
                tool_use_id,
                reason: ask_reason(request),
            });
        }
    }

    fn block_id(&self, index: u64) -> String {
        format!("{}:{index}", self.msg_id.as_deref().unwrap_or("msg"))
    }
}

/// 「为什么问我」这句话从哪儿取。
///
/// 🔴 真机实测（2026-10-24）**不是每个 `can_use_tool` 都带 `decision_reason`**：
/// - 工作目录外的路径：`decision_reason: "Path is outside allowed working directories"`
/// - 需要提权的命令：没有 `decision_reason`，只有一个 `description`
///   （`"Write ok to file and read it back"`）
///
/// 只读 `decision_reason` 的话，后者会渲染成空字符串，卡片上那行解释直接消失 ——
/// 而它正是「让用户别条件反射按允许」的唯一依据。所以按重要性依次回退。
fn ask_reason(request: Option<&Value>) -> Option<String> {
    let r = request?;
    // `description` 有时是路径（`~\.claude\settings.json`），有时是人话。
    // 优先用完整句子，拿不到再退到它。
    for key in ["decision_reason", "description"] {
        if let Some(s) = r
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(s.to_string());
        }
    }
    None
}

/// `result` 行 → `TurnEnd`。
///
/// 🔴 `usage` 原样透传而不是拆成字段：CLI 在 `usage` 里塞了 `cache_read_input_tokens`、
/// `server_tool_use`、`service_tier` 等十几个键，版本间还在加。前端只需要读其中几个，
/// 拆成结构体等于每加一个键就改一次 Rust。
fn turn_end(value: &Value) -> CcEvent {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    let is_error = value
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || subtype.starts_with("error");
    CcEvent::TurnEnd {
        session_id: value
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        is_error,
        text: value
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage: value.get("usage").cloned(),
        // 上下文余量条的唯一数据源（探针 0-3）：`usage` 里没有 contextWindow，
        // 它在 `modelUsage.<model>` 里，且是 camelCase——与 `usage` 的 snake_case
        // 不是一套命名，别读错键。
        model_usage: value.get("modelUsage").cloned(),
        // 不同版本放在不同层的两个位置都试一遍。
        cost_usd: value
            .get("total_cost_usd")
            .or_else(|| value.get("cost_usd"))
            .and_then(Value::as_f64),
        num_turns: value.get("num_turns").and_then(Value::as_u64),
        duration_ms: value.get("duration_ms").and_then(Value::as_u64),
    }
}

fn format_retry(value: &Value, attempt: u64, max: u64) -> String {
    let delay_ms = value
        .get("retry_delay_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let detail = value
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|e| !e.is_empty() && *e != "unknown");
    let mut msg = match value.get("error_status").and_then(Value::as_u64) {
        Some(code) => format!("API 返回 HTTP {code}"),
        None => match detail {
            Some(detail) => format!("API 错误：{detail}"),
            None => "API 错误".to_string(),
        },
    };
    if max > 0 {
        msg.push_str(&format!(
            "，{:.1}s 后重试（{attempt}/{max}）",
            delay_ms as f64 / 1000.0
        ));
    }
    msg
}

/// `tool_result.content` 可能是字符串、`[{type:"text",text}]`、或混合块数组。
/// 只取文本，非文本块（图片等）用占位符标出来 —— 静默丢掉会让用户以为工具没输出。
///
/// `pub(crate)` 是因为历史回放（`cc_history::parse`）要处理**同一种**块数组：
/// jsonl 里的 `tool_result` 与实时流里的完全是同一个形状，各写一份迟早漂。
pub(crate) fn flatten_content(content: Option<&Value>) -> String {
    match content {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item.get("type").and_then(Value::as_str) {
                Some("text") => item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                Some(other) => format!("[{other}]"),
                None => item.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(state: &mut ProtoState, lines: &[&str]) -> Vec<CcEvent> {
        let mut out = Vec::new();
        for line in lines {
            out.extend(state.feed(line));
        }
        out
    }

    #[test]
    fn init_carries_session_id_for_resume() {
        let mut state = ProtoState::new();
        let out = state.feed(r#"{"type":"system","subtype":"init","session_id":"s-1"}"#);
        assert_eq!(
            out,
            vec![CcEvent::Init {
                session_id: "s-1".into(),
                cwd: None,
                model: None
            }]
        );
    }

    /// 流式碎片与完整消息**共用 block_id**，所以前端覆盖不会重复。
    #[test]
    fn stream_delta_and_full_message_share_block_id() {
        let mut state = ProtoState::new();
        let out = feed_all(
            &mut state,
            &[
                r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
                r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"你好"}]}}"#,
            ],
        );
        let texts: Vec<&CcEvent> = out
            .iter()
            .filter(|e| matches!(e, CcEvent::Text { .. }))
            .collect();
        assert_eq!(texts.len(), 3, "两条 delta + 一条完整：{out:?}");
        for event in &texts {
            let CcEvent::Text { block_id, .. } = event else {
                unreachable!()
            };
            assert_eq!(block_id, "m1:0", "block_id 必须一致，否则覆盖不到");
        }
        assert!(matches!(
            texts[2],
            CcEvent::Text {
                streaming: false,
                ..
            }
        ));
    }

    /// 🔴 真机形状（2026-10-24 从中转站抓到）：一条消息里 thinking 与 text 分两次
    /// `assistant` 事件送来，两次 `content` 都从下标 0 起；而流式的 `index` 是连续的
    /// （thinking=0、text=1）。完整快照的 block_id 必须跟着流式的 index 走，
    /// 否则 text 会同时落在 `id:0`（完整）和 `id:1`（流式累积）⇒ 界面上同一段话两遍。
    #[test]
    fn split_assistant_events_keep_stream_block_indices() {
        let mut state = ProtoState::new();
        let out = feed_all(
            &mut state,
            &[
                r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m9"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"正文"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#,
                // 中转站把同一 message 拆成两条快照，内容各自从 0 开始
                r#"{"type":"assistant","message":{"id":"m9","content":[{"type":"thinking","thinking":"先想"}]}}"#,
                r#"{"type":"assistant","message":{"id":"m9","content":[{"type":"text","text":"正文"}]}}"#,
            ],
        );
        let text_ids: Vec<&str> = out
            .iter()
            .filter_map(|e| match e {
                CcEvent::Text { block_id, .. } => Some(block_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            text_ids,
            vec!["m9:1", "m9:1"],
            "流式累积与完整快照必须落在同一个 block_id 上"
        );
        let thinking_ids: Vec<&str> = out
            .iter()
            .filter_map(|e| match e {
                CcEvent::Thinking { block_id, .. } => Some(block_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            thinking_ids,
            vec!["m9:0", "m9:0"],
            "thinking 不能被 text 撞掉"
        );
    }

    /// 工具入参是 `input_json_delta` 碎片拼起来的，`content_block_stop` 才算完。
    #[test]
    fn tool_use_input_is_assembled_before_emitting() {
        let mut state = ProtoState::new();
        let out = feed_all(
            &mut state,
            &[
                r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m2"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"a.ts\"}"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            ],
        );
        match out.last() {
            Some(CcEvent::ToolUse {
                tool_use_id,
                name,
                input,
            }) => {
                assert_eq!(tool_use_id, "t1");
                assert_eq!(name, "Read");
                assert_eq!(input["file_path"], "a.ts");
            }
            other => panic!("期望 ToolUse，实际 {other:?}"),
        }
    }

    /// tool_result 的 content 是块数组，要拍平成文本。
    #[test]
    fn tool_result_content_is_flattened() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"第一行"},{"type":"image"}],"is_error":true}]}}"#,
        );
        assert_eq!(
            out,
            vec![CcEvent::ToolResult {
                tool_use_id: "t1".into(),
                content: "第一行\n[image]".into(),
                is_error: true
            }]
        );
    }

    /// 🔴 `can_use_tool` 必须带 `request_id`，否则回写无处可去 —— 丢弃比转圈好。
    #[test]
    fn permission_ask_without_request_id_is_dropped() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{}}}"#,
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn permission_ask_and_question_are_split_by_tool_name() {
        let mut state = ProtoState::new();
        let ask = state.feed(
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1","decision_reason":"需要写工作区外"}}"#,
        );
        match &ask[0] {
            CcEvent::PermissionAsk {
                request_id,
                tool_name,
                reason,
                ..
            } => {
                assert_eq!(request_id, "r1");
                assert_eq!(tool_name, "Bash");
                assert_eq!(reason.as_deref(), Some("需要写工作区外"));
            }
            other => panic!("期望 PermissionAsk，实际 {other:?}"),
        }

        let question = state.feed(
            r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[]},"tool_use_id":"t2"}}"#,
        );
        assert!(
            matches!(question[0], CcEvent::Question { .. }),
            "{question:?}"
        );
    }

    /// `auto` 标记必须能序列化：前端与落盘都靠它区分「用户点的」和「规则放的」。
    #[test]
    fn permission_resolved_auto_flag_serializes() {
        let ev = CcEvent::PermissionResolved {
            request_id: "r1".into(),
            decision: "allow".into(),
            auto: true,
        };
        let json = serde_json::to_string(&ev).expect("序列化");
        assert!(json.contains("\"auto\":true"), "{json}");
        // camelCase 约定：字段名不能变成 auto_flag 之类。
        assert!(json.contains("\"requestId\":\"r1\""), "{json}");
    }

    /// 🔴 老流水（2026-10-24 之前落盘的会话）里没有 `auto` 字段。
    /// 读不回来 = 整条会话恢复失败，用户看到的是「上次的对话消失了」。
    #[test]
    fn old_permission_resolved_without_auto_still_loads() {
        let json = r#"{"kind":"permissionResolved","requestId":"r1","decision":"allow"}"#;
        let ev: CcEvent = serde_json::from_str(json).expect("老流水必须能读");
        match ev {
            CcEvent::PermissionResolved { auto, .. } => {
                assert!(!auto, "老事件本来就是人工的，默认 false");
            }
            other => panic!("期望 PermissionResolved，实际 {other:?}"),
        }
    }

    /// 真机样本（2026-10-24 实抓，`--permission-prompt-tool stdio` + `--permission-mode default`）。
    ///
    /// 这条样本证明了三件当时只能靠推断的事：
    /// 1. `request_id` 在**外层**，不在 `request` 里；
    /// 2. `can_use_tool` 里**没有** `decision_reason` 只有 `description`；
    /// 3. 还带了 `permission_suggestions` / `blocked_path` / `decision_reason_type`
    ///    —— 我们目前不用，但别让解析被它们搞崩。
    #[test]
    fn real_can_use_tool_without_decision_reason() {
        let mut state = ProtoState::new();
        let out = state.feed(r#"{"type":"control_request","request_id":"a5ad87b7-b860-4274-9520-aa07cfe0f900","request":{"subtype":"can_use_tool","tool_name":"PowerShell","display_name":"PowerShell","input":{"command":"echo ok > cc-probe-ok.txt","description":"Write ok to file and read it back"},"description":"Write ok to file and read it back","permission_suggestions":[{"type":"addDirectories","directories":["C:\\Temp"],"destination":"session"}],"blocked_path":"C:\\Temp\\cc-probe-ok.txt","decision_reason_type":"subcommandResults","tool_use_id":"chatcmpl-tool-a4b87af5489d9b0b"}}"#);
        match &out[0] {
            CcEvent::PermissionAsk {
                request_id,
                tool_name,
                reason,
                tool_use_id,
                ..
            } => {
                assert_eq!(request_id, "a5ad87b7-b860-4274-9520-aa07cfe0f900");
                assert_eq!(tool_name, "PowerShell");
                assert_eq!(
                    reason.as_deref(),
                    Some("Write ok to file and read it back"),
                    "没有 decision_reason 时必须退到 description，否则卡片上那行解释是空的"
                );
                assert_eq!(
                    tool_use_id.as_deref(),
                    Some("chatcmpl-tool-a4b87af5489d9b0b")
                );
            }
            other => panic!("期望 PermissionAsk，实际 {other:?}"),
        }
    }

    /// 没有任何解释字段时 `reason` 是 `None`，由前端兜一句默认文案 —— 不能变成空串。
    #[test]
    fn ask_without_any_reason_yields_none() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"control_request","request_id":"r9","request":{"subtype":"can_use_tool","tool_name":"Read","input":{}}}"#,
        );
        match &out[0] {
            CcEvent::PermissionAsk { reason, .. } => assert!(reason.is_none(), "{reason:?}"),
            other => panic!("期望 PermissionAsk，实际 {other:?}"),
        }
    }

    /// `api_retry` 是进度不是错误：不能进 TurnEnd，也不能被当失败处理。
    #[test]
    fn api_retry_is_progress_not_error() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":8000,"error_status":529}"#,
        );
        match &out[0] {
            CcEvent::Retry {
                attempt,
                max,
                message,
            } => {
                assert_eq!((*attempt, *max), (3, 10));
                assert!(message.contains("529"), "{message}");
                assert!(message.contains("3/10"), "{message}");
            }
            other => panic!("期望 Retry，实际 {other:?}"),
        }
    }

    #[test]
    fn result_maps_error_subtype_to_is_error() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s-2","result":"boom","num_turns":3,"usage":{"input_tokens":10}}"#,
        );
        match &out[0] {
            CcEvent::TurnEnd {
                is_error,
                text,
                session_id,
                num_turns,
                ..
            } => {
                assert!(is_error);
                assert_eq!(text.as_deref(), Some("boom"));
                assert_eq!(session_id.as_deref(), Some("s-2"));
                assert_eq!(*num_turns, Some(3));
            }
            other => panic!("期望 TurnEnd，实际 {other:?}"),
        }
    }

    /// `modelUsage` 必须原样透传（上下文余量条的唯一数据源，探针 0-3 实测
    /// 每轮 `result` 都带），且落盘字段是 camelCase；老流水缺这个字段要能读回
    /// `None`，不能反序列化失败被整箱丢掉。
    #[test]
    fn result_passes_model_usage_through_and_old_streams_still_load() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"result","subtype":"success","session_id":"s-3","usage":{"input_tokens":5},"modelUsage":{"claude-opus-5":{"inputTokens":40779,"outputTokens":384,"contextWindow":1000000}}}"#,
        );
        match &out[0] {
            CcEvent::TurnEnd { model_usage, .. } => {
                let mu = model_usage.as_ref().expect("modelUsage 必须透传");
                let opus = mu.get("claude-opus-5").expect("按模型名索引");
                assert_eq!(
                    opus.get("contextWindow").and_then(Value::as_u64),
                    Some(1_000_000)
                );
                assert_eq!(opus.get("inputTokens").and_then(Value::as_u64), Some(40779));
            }
            other => panic!("期望 TurnEnd，实际 {other:?}"),
        }
        // 老流水（落盘时还没有这个字段）必须读得回来。
        let old = r#"{"kind":"turnEnd","sessionId":"s-3","isError":false,"text":null,"usage":null,"costUsd":null,"numTurns":null,"durationMs":null}"#;
        match serde_json::from_str::<CcEvent>(old).expect("老流水必须能读回") {
            CcEvent::TurnEnd { model_usage, .. } => assert!(model_usage.is_none()),
            other => panic!("期望 TurnEnd，实际 {other:?}"),
        }
    }

    /// 坏行、空行、BOM 都不能掀翻整轮。
    #[test]
    fn junk_lines_are_skipped_silently() {
        let mut state = ProtoState::new();
        assert!(state.feed("").is_empty());
        assert!(state.feed("   ").is_empty());
        assert!(state.feed("not json at all").is_empty());
        assert!(state.feed("\u{feff}{\"type\":\"unknown\"}").is_empty());
        // 带 BOM 的合法行仍要解析出来。
        let out =
            state.feed("\u{feff}{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-3\"}");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn compact_boundary_reports_post_tokens() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":1234}}"#,
        );
        assert_eq!(out, vec![CcEvent::Compact { post_tokens: 1234 }]);
    }

    #[test]
    fn background_tasks_changed_counts_array() {
        let mut state = ProtoState::new();
        let out = state.feed(
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a"},{"task_id":"b"}]}"#,
        );
        assert_eq!(out, vec![CcEvent::BackgroundTasks { pending: 2 }]);
    }

    /// 事件发到前端是 camelCase —— 与 Tauri 命令参数约定一致。
    #[test]
    fn events_serialize_to_camel_case() {
        let json = serde_json::to_string(&CcEvent::PermissionAsk {
            request_id: "r1".into(),
            tool_name: "Bash".into(),
            input: Value::Null,
            tool_use_id: None,
            reason: None,
        })
        .expect("序列化");
        assert!(json.contains("\"kind\":\"permissionAsk\""), "{json}");
        assert!(json.contains("\"requestId\""), "{json}");
        assert!(json.contains("\"toolName\""), "{json}");
    }
}
