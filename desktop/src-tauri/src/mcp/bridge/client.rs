//! stdio MCP 客户端：NDJSON 上的 JSON-RPC 2.0。
//!
//! 只实现桥接需要的四个方法：`initialize` / `notifications/initialized` /
//! `tools/list` / `tools/call`。不做 resources / prompts / 采样（方案 §13）。
//!
//! **为何不用 rmcp**（方案 §2）：用它就拿不回进程树控制权（它的 transport 自己管
//! 子进程，而实测证明 `kill_on_drop` 只能杀到第二层）；且它很可能破掉 `windows` crate
//! 锁在 0.56 的对齐。而要写的东西就这么多。
//!
//! 🔴 **本模块不碰进程**。它只要一对 `Read` / `Write`，所以协议逻辑能用内存管道
//! 完整单测——不依赖本机装了任何真实 MCP server，CI 上照跑。进程那一层在 `spawn.rs`，
//! 两者在 `mod.rs` 里拼起来。

use std::io::{BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// 我们首选的协议版本。server 回别的就跟着改（见 `negotiated_version`）。
pub const PREFERRED_PROTOCOL: &str = "2024-11-05";

/// 单行上限 8MB，与 `maxFileSizeBytes` 同量级。
///
/// 超过则**报错并断连**，不静默截断——截断的 JSON 解不开，只会变成更难查的错。
/// 它同时是“一个发疯的 server 把内存吃光”的兜底（CLAUDE.md §8.1 第 5 条）。
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// 读线程送回来的东西。
enum Msg {
    /// 一行原文（已做 lossy 解码，未保证是 JSON）。
    Line(String),
    /// 读侧致命错误（行超长 / IO 错）。EOF 不走这里，走 channel 断开。
    Fatal(String),
}

/// 一次调用的结果分类。
pub struct ToolCall {
    /// 外挂 server 返回的 `content` 数组原文。
    pub content: Value,
    /// server 自己标的“这是个错误结果”（协议层成功，业务层失败）。
    pub is_error: bool,
}

/// 已完成握手的连接。
///
/// **串行语义**：stdin/stdout 是单一流，所有方法都取 `&mut self`，编译器就替我们
/// 保证了“同一连接上不会有两个请求交错”。多路复用留到将来挂上带网络 IO 的慢 server 时再做。
pub struct Client {
    writer: Box<dyn Write + Send>,
    rx: Receiver<Msg>,
    next_id: u64,
    /// 一旦中毒就不能再用——参见 `poison_with` 的注释。**超时不算中毒**。
    poison: Option<String>,
    /// 被放弃（超时）的请求数。它们的响应迟到时会按 id 丢掉，这里只作诊断。
    abandoned: u64,
    /// 跟不上 JSON 的行有多少（诊断用）。
    noise_lines: u64,
    server_info: Value,
    instructions: Option<String>,
    protocol_version: String,
}

/// 手写而不是 `#[derive(Debug)]`：`Box<dyn Write>` 没有 Debug。
///
/// 不是为了好看——`Result<Client, _>::expect_err` 要求 `T: Debug`，没它连测试都写不了。
/// 顺带也让日志里能直接打印连接状态。**不得打印任何报文内容**（可能含敏感参数）。
impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("protocol", &self.protocol_version)
            .field("server", &self.server_info.get("name"))
            .field("noise_lines", &self.noise_lines)
            .field("poisoned", &self.poison.is_some())
            .field("abandoned", &self.abandoned)
            .finish()
    }
}

impl Client {
    /// 在一对已有的管道上完成握手。
    ///
    /// `reader` 会被搬到一个读线程里（阻塞读，不轮询、不定时器）。
    pub fn handshake<R, W>(reader: R, writer: W, timeout: Duration) -> Result<Self, String>
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let rx = spawn_reader(reader);
        let mut c = Client {
            writer: Box::new(writer),
            rx,
            next_id: 0,
            poison: None,
            abandoned: 0,
            noise_lines: 0,
            server_info: Value::Null,
            instructions: None,
            protocol_version: PREFERRED_PROTOCOL.to_string(),
        };

        let result = c.initialize(PREFERRED_PROTOCOL, timeout)?;

        // 协议版本协商（方案 §8.1）：server 回什么就用什么。
        // 规范允许 server 选一个与客户端不同的版本，写死就只能接一种 server。
        if let Some(v) = result.get("protocolVersion").and_then(|v| v.as_str()) {
            c.protocol_version = v.to_string();
        }

        // 能力检查：没有 `tools` 就直接定性为不可用。
        // 不要接着去调 `tools/list` 再拿一个不知所云的错误，那对用户毫无帮助。
        let has_tools = result
            .get("capabilities")
            .and_then(|c| c.get("tools"))
            .is_some();
        if !has_tools {
            return Err(
                "该 MCP server 未声明 `tools` 能力，桥接只代理工具调用，对它无能为力。".to_string(),
            );
        }

        c.server_info = result.get("serverInfo").cloned().unwrap_or(Value::Null);
        c.instructions = result
            .get("instructions")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 握手完成通知（无 id，不等回包）。
        c.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))?;
        Ok(c)
    }

    pub fn server_info(&self) -> &Value {
        &self.server_info
    }
    pub fn instructions(&self) -> Option<&str> {
        self.instructions.as_deref()
    }
    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }
    pub fn noise_lines(&self) -> u64 {
        self.noise_lines
    }
    pub fn is_poisoned(&self) -> bool {
        self.poison.is_some()
    }

    /// `tools/list`。返回 `tools` 数组原文（含完整 `inputSchema`）。
    pub fn list_tools(&mut self, timeout: Duration) -> Result<Value, String> {
        let r = self.request("tools/list", json!({}), timeout)?;
        Ok(r.get("tools").cloned().unwrap_or_else(|| json!([])))
    }

    /// `tools/call`。
    pub fn call_tool(
        &mut self,
        name: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<ToolCall, String> {
        let r = self.request(
            "tools/call",
            json!({ "name": name, "arguments": args }),
            timeout,
        )?;
        Ok(ToolCall {
            content: r.get("content").cloned().unwrap_or_else(|| json!([])),
            is_error: r.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
        })
    }

    fn initialize(&mut self, version: &str, timeout: Duration) -> Result<Value, String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": version,
                // 我们不声明任何能力：不提供 roots、不接采样。
                // 这让守规矩的 server 不会反向发请求；不守规矩的那些由 `pump` 里的
                // -32601 回复兜住（否则它会一直等而把整条连接拖死）。
                "capabilities": {},
                "clientInfo": { "name": "cc-bridge", "version": env!("CARGO_PKG_VERSION") }
            }),
            timeout,
        )
    }

    /// 发一条请求并等到同号 id 的响应。
    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if let Some(p) = &self.poison {
            return Err(format!("连接已不可用：{p}"));
        }
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))?;
        self.pump(id, method, timeout)
    }

    fn send(&mut self, msg: &Value) -> Result<(), String> {
        let line = format!("{msg}\n");
        self.writer
            .write_all(line.as_bytes())
            .and_then(|_| self.writer.flush())
            .map_err(|e| {
                let m = format!("写入 server 失败：{e}");
                self.poison = Some(m.clone());
                m
            })
    }

    /// 读到带指定 id 的响应为止。途中的噪声 / 通知 / 反向请求都在这里处理。
    fn pump(&mut self, want: u64, method: &str, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // 🔴 超时**不再**销毁连接（原方案 §8.3 是超时即中毒，实测证明那条不成立）。
                //
                // 真机联调：codegraph 在一个 1.5GB 索引的项目上前两次调用都超过 60s，
                // 而每次超时都销毁连接 → 下次从冷启动重来 → 永远收敛不了。
                // 它最后能成功纯属侥幸——codegraph 自己有个共享 daemon 在后台预热。
                //
                // 保留连接是安全的：id 单调递增且请求串行（方法都取 `&mut self`），
                // 所以放弃的那条响应迟到时 id 必定**小于**下一个 want，会被下面
                // `_ => continue` 丢掉。§8.3 担心的“拿到别人的结果”需要 id 撞车，
                // 而这里撞不上。
                self.abandoned += 1;
                return Err(format!(
                    "{method} 超时（{}s）。连接保留，迟到的响应会被丢弃——可以直接重试，server 已经加载的东西不会白费。",
                    timeout.as_secs()
                ));
            }
            let line = match self.rx.recv_timeout(left) {
                Ok(Msg::Line(l)) => l,
                Ok(Msg::Fatal(e)) => return Err(self.poison_with(e)),
                Err(RecvTimeoutError::Timeout) => continue, // 下一圈算剩余时间，统一在上面报超时
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.poison_with(
                        "server 进程已退出（stdout 关闭）。它可能启动失败或中途崩溃。".to_string(),
                    ))
                }
            };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // 非 JSON 行：跳过并计数。
            // 实测 codegraph 0.9.9 的 stdout 是干净的，但通用桥面对的是任意人写的 server，
            // Node/Python 写的很常见把日志混进 stdout。一行 if 的成本，换掉一类难查的故障。
            let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                self.noise_lines += 1;
                continue;
            };

            // 反向请求（带 id 且带 method）：我们什么能力都没声明，按规范回 -32601。
            // 不能静默忽略——对方会一直等，把整条连接拖到超时。
            if v.get("method").is_some() {
                if let Some(rid) = v.get("id") {
                    let reply = json!({
                        "jsonrpc": "2.0", "id": rid,
                        "error": { "code": -32601, "message": "cc-bridge 未声明任何客户端能力" }
                    });
                    self.send(&reply)?;
                }
                continue; // 通知（无 id）直接丢弃
            }

            match v.get("id").and_then(|i| i.as_u64()) {
                Some(id) if id == want => {
                    if let Some(err) = v.get("error") {
                        return Err(format!("{method} 被 server 拒绝：{err}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                // 别人的 id：串行语义下只有一种来源——**之前超时放弃的那条请求**，
                // 它的响应迟到了。丢掉即可，这正是超时后还能安全复用连接的原因。
                _ => continue,
            }
        }
    }

    /// 把连接标为不可用。
    ///
    /// 只用于**真的没救了**的情形：读线程报错、server 进程退出、写管道失败。
    /// **超时不走这里**——那只是这一次慢，连接本身还好着（见 `pump` 里的说明）。
    fn poison_with(&mut self, msg: String) -> String {
        if self.poison.is_none() {
            self.poison = Some(msg.clone());
        }
        msg
    }
}

/// 读线程。对照 CLAUDE.md §8.1 逐条：
/// ① 让出点：在管道上阻塞读；② 生产端死 → 读到 EOF → **显式退出线程**；
/// ③ EOF 与读错各自分支，无 `let _ = …`；④ 一次管道读，无轮询无定时器；
/// ⑤ 单行 8MB 上限；⑥ 无平台分支。
fn spawn_reader<R: Read + Send + 'static>(reader: R) -> Receiver<Msg> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        loop {
            match read_line_capped(&mut buf, MAX_LINE_BYTES) {
                Ok(None) => return, // EOF：channel 随之断开，接收端会看到 Disconnected
                Ok(Some(bytes)) => {
                    // 🔴 lossy 而不是严格 UTF-8：中文 Windows 上 Python/Node 写的 server
                    // 很可能向 stdout 吐 GBK 日志，一个乱码字节不能把整条连接弄断。
                    let s = String::from_utf8_lossy(&bytes).into_owned();
                    if tx.send(Msg::Line(s)).is_err() {
                        return; // 接收端没了，收工（不弄成热循环）
                    }
                }
                Err(e) => {
                    let _ = tx.send(Msg::Fatal(e));
                    return;
                }
            }
        }
    });
    rx
}

/// 读一行（含上限）。返回 `Ok(None)` 表示 EOF。
///
/// 不用 `BufRead::read_line`：它要求严格 UTF-8，遇非法字节直接 `Err`。
/// 也不用 `read_until`：它没有上限，一个不吐换行的 server 能把内存吃光。
fn read_line_capped<R: Read>(
    buf: &mut BufReader<R>,
    cap: usize,
) -> Result<Option<Vec<u8>>, String> {
    use std::io::BufRead;
    let mut out: Vec<u8> = Vec::new();
    loop {
        let available = match buf.fill_buf() {
            Ok(b) => b,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("读取 server 输出失败：{e}")),
        };
        if available.is_empty() {
            // EOF：有残留就当最后一行（最后一行可能不带 \n）。
            return Ok(if out.is_empty() { None } else { Some(out) });
        }
        match available.iter().position(|&b| b == b'\n') {
            Some(i) => {
                if out.len() + i > cap {
                    return Err(over_cap(cap));
                }
                out.extend_from_slice(&available[..i]);
                buf.consume(i + 1);
                // 吃掉 CRLF 的 \r，否则 serde_json 也能解但 trim 前的判断会奇怪。
                if out.last() == Some(&b'\r') {
                    out.pop();
                }
                return Ok(Some(out));
            }
            None => {
                let n = available.len();
                if out.len() + n > cap {
                    return Err(over_cap(cap));
                }
                out.extend_from_slice(available);
                buf.consume(n);
            }
        }
    }
}

fn over_cap(cap: usize) -> String {
    format!(
        "server 输出的单行超过 {}MB 上限，已断开连接。它可能在向 stdout 吐大量非协议内容。",
        cap / 1024 / 1024
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    /// 可检查的 writer：把写出去的字节攒起来。
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Sink {
        fn lines(&self) -> Vec<Value> {
            let raw = self.0.lock().unwrap().clone();
            String::from_utf8_lossy(&raw)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str(l).expect("我们发出的必须是合法 JSON"))
                .collect()
        }
    }
    fn ok_init(extra_caps: &str) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2024-11-05","capabilities":{{{extra_caps}}},"serverInfo":{{"name":"fake","version":"0.1"}},"instructions":"用法说明"}}}}"#
        )
    }

    fn t() -> Duration {
        Duration::from_secs(5)
    }

    /// B2：完整握手。同时验证发出去的三条报文形状正确。
    #[test]
    fn handshake_then_list_tools() {
        let script = format!(
            "{}\n{}\n",
            ok_init(r#""tools":{}"#),
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a","inputSchema":{}}]}}"#
        );
        let sink = Sink::default();
        let mut c = Client::handshake(Cursor::new(script), sink.clone(), t()).expect("握手应成功");

        assert_eq!(c.server_info()["name"], "fake");
        assert_eq!(c.instructions(), Some("用法说明"));
        assert_eq!(c.protocol_version(), "2024-11-05");

        let tools = c.list_tools(t()).expect("list 应成功");
        assert_eq!(tools[0]["name"], "a");

        let sent = sink.lines();
        assert_eq!(sent[0]["method"], "initialize");
        assert_eq!(sent[1]["method"], "notifications/initialized");
        assert!(sent[1].get("id").is_none(), "通知不能带 id");
        assert_eq!(sent[2]["method"], "tools/list");
    }

    /// B3：stdout 里混进非 JSON 日志 → 跳过并计数，不影响协议。
    #[test]
    fn non_json_noise_is_skipped_and_counted() {
        let script = format!(
            "starting server…\n{}\n[warn] cache miss\n",
            ok_init(r#""tools":{}"#)
        );
        let c = Client::handshake(Cursor::new(script), Sink::default(), t())
            .expect("噪声不应该弄坏握手");
        assert_eq!(c.noise_lines(), 1, "握手前那行噪声应被计数");
        // 握手后那行噪声会在下一次请求时被读到，同样不应报错（这里只验到握手）。
        assert!(!c.is_poisoned());
    }

    /// B4：非 UTF-8 字节（GBK 日志）→ lossy 解码，连接不断。
    #[test]
    fn invalid_utf8_does_not_break_the_connection() {
        let mut script: Vec<u8> = Vec::new();
        script.extend_from_slice(&[0xC4, 0xE3, 0xBA, 0xC3]); // GBK 的“你好”，不是合法 UTF-8
        script.push(b'\n');
        script.extend_from_slice(ok_init(r#""tools":{}"#).as_bytes());
        script.push(b'\n');

        let c =
            Client::handshake(Cursor::new(script), Sink::default(), t()).expect("乱码行不应该断连");
        assert_eq!(c.noise_lines(), 1);
        assert!(!c.is_poisoned());
    }

    /// 先阻塞一会儿再吐剩下的内容，用来造「响应迟到」。
    struct DelayedTail {
        delay: Duration,
        tail: Cursor<Vec<u8>>,
        slept: bool,
    }
    impl Read for DelayedTail {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if !self.slept {
                std::thread::sleep(self.delay);
                self.slept = true;
            }
            self.tail.read(buf)
        }
    }

    /// B5（按方案 3 改写）：超时**不再**销毁连接，且迟到的响应会被按 id 丢掉。
    ///
    /// 原行为是超时即中毒、下次重建。真机上这条不成立：codegraph 在一个 1.5GB
    /// 索引的项目上前两次调用都超过 60s，而每次超时都重建 → 每次都冷启动 →
    /// 永远收敛不了。本测试钉住新行为：超时后连接还能用，且不会把迟到的旧响应
    /// 当成新请求的结果。
    #[test]
    fn timeout_keeps_connection_usable_and_drops_late_reply() {
        // 握手用 id 1；第一次 list_tools 是 id 2（会超时），第二次是 id 3。
        let head = format!("{}\n", ok_init(r#""tools":{}"#));
        let late = concat!(
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"迟到的"}]}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"该拿的"}]}}"#,
            "\n"
        );
        let reader = Cursor::new(head).chain(DelayedTail {
            delay: Duration::from_millis(250),
            tail: Cursor::new(late.as_bytes().to_vec()),
            slept: false,
        });
        let mut c = Client::handshake(reader, Sink::default(), t()).expect("握手应成功");

        let err = c
            .list_tools(Duration::from_millis(60))
            .expect_err("第一次应该超时");
        assert!(err.contains("超时"), "实际：{err}");
        assert!(
            !c.is_poisoned(),
            "超时不该再销毁连接——那会让慢 server 永远起不来"
        );

        // 第二次：迟到的 id 2 会先到，必须被丢掉，拿到的应该是 id 3。
        let tools = c.list_tools(Duration::from_secs(5)).expect("重试应该成功");
        assert_eq!(
            tools[0]["name"], "该拿的",
            "迟到的响应必须按 id 丢掉，绝不能当成本次请求的结果"
        );
    }

    /// B6：server 回一个**不同的** protocolVersion → 按它的来，不报错。
    #[test]
    fn server_chosen_protocol_version_wins() {
        let script = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","#,
            r#""capabilities":{"tools":{}},"serverInfo":{"name":"fake"}}}"#,
            "\n"
        );
        let c = Client::handshake(Cursor::new(script), Sink::default(), t()).expect("应成功");
        assert_eq!(
            c.protocol_version(),
            "2025-06-18",
            "写死版本就只能接一种 server，通用桥不能这么干"
        );
    }

    /// B7：不声明 `tools` 能力 → 直接定性不可用，而不是去调 tools/list 拿个怪错。
    #[test]
    fn server_without_tools_capability_is_rejected() {
        let script = format!("{}\n", ok_init(r#""prompts":{}"#));
        let err = Client::handshake(Cursor::new(script), Sink::default(), t())
            .expect_err("无 tools 能力应直接失败");
        assert!(err.contains("tools"), "错误要说清楚原因：{err}");
    }

    /// server 反向发请求（我们没声明任何能力）→ 必须回 -32601。
    /// 静默忽略的话对方会一直等，把整条连接拖到超时。
    #[test]
    fn server_initiated_request_gets_method_not_found() {
        let script = format!(
            "{}\n{}\n{}\n",
            ok_init(r#""tools":{}"#),
            r#"{"jsonrpc":"2.0","id":"s1","method":"sampling/createMessage","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#
        );
        let sink = Sink::default();
        let mut c = Client::handshake(Cursor::new(script), sink.clone(), t()).expect("握手");
        c.list_tools(t()).expect("应能跳过反向请求拿到自己的回包");

        let sent = sink.lines();
        let reply = sent
            .iter()
            .find(|m| m.get("error").is_some())
            .expect("必须回一条错误响应");
        assert_eq!(reply["id"], "s1");
        assert_eq!(reply["error"]["code"], -32601);
    }

    /// server 回 JSON-RPC error → 当成失败，且错误原文要带回去。
    #[test]
    fn jsonrpc_error_is_surfaced_verbatim() {
        let script = format!(
            "{}\n{}\n",
            ok_init(r#""tools":{}"#),
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"bad args"}}"#
        );
        let mut c = Client::handshake(Cursor::new(script), Sink::default(), t()).expect("握手");
        let err = c.list_tools(t()).expect_err("应失败");
        assert!(err.contains("bad args"), "要把 server 的原文带回去：{err}");
    }

    /// server 一启动就死（stdout 直接 EOF）→ 报可读的错，不是超时等满。
    #[test]
    fn immediate_eof_reports_process_exit() {
        let err = Client::handshake(Cursor::new(""), Sink::default(), t()).expect_err("应失败");
        assert!(err.contains("退出"), "实际：{err}");
    }

    /// 单行上限：超过就报错断连，不静默截断。
    #[test]
    fn oversized_line_is_an_error_not_a_silent_truncation() {
        let mut buf = BufReader::new(Cursor::new(vec![b'x'; 100]));
        let err = read_line_capped(&mut buf, 10).expect_err("应超限");
        assert!(err.contains("上限"), "实际：{err}");
    }

    /// CRLF 行尾不能把 `\r` 带进来。
    #[test]
    fn crlf_line_ending_is_trimmed() {
        let mut buf = BufReader::new(Cursor::new(b"abc\r\ndef\n".to_vec()));
        assert_eq!(read_line_capped(&mut buf, 99).unwrap().unwrap(), b"abc");
        assert_eq!(read_line_capped(&mut buf, 99).unwrap().unwrap(), b"def");
        assert!(read_line_capped(&mut buf, 99).unwrap().is_none(), "该 EOF");
    }

    /// 最后一行不带 `\n` 也要能读出来。
    #[test]
    fn last_line_without_newline_is_still_read() {
        let mut buf = BufReader::new(Cursor::new(b"tail".to_vec()));
        assert_eq!(read_line_capped(&mut buf, 99).unwrap().unwrap(), b"tail");
        assert!(read_line_capped(&mut buf, 99).unwrap().is_none());
    }
}
