# O1 实施方案 · 审计日志结构化耗时拆解（serverMs / ioMs / auditMs / overheadMs / netMs）

> 状态：方案已定，**未动手**（遵循 CLAUDE.md 规则5：本方案不含 commit / push / 版本 bump，实现后等用户明确说"提交"才只 commit 不 push）。
> 目标：把每条 `tools/call` 审计记录从「只有 `durationMs`（仅包住 dispatch 调度）」拆成可读的四维耗时，让瓶颈一键定位在 **网络往返 / 响应体过大(overhead) / 文件读写(io) / 审计写盘(audit)** 哪一层。
> 关联：① gzip 压缩 + ② batch 工具已实现并通过测试；O1 是**量化这两项真实收益**的必要度量项（用真实 `audit.log` 数据，而非再靠猜）。

---

## 0. 关键设计决策（先看这 6 条，避免返工）

- **A. 字段名是硬契约，必须严格等于前端 `types.ts:65-69`**：`serverMs` / `ioMs` / `auditMs` / `netMs` / `overheadMs`。已核对 `PerfCharts.tsx:145` 用 `e.serverMs != null` 触发堆叠条，`f("ioMs")/f("auditMs")/f("netMs")/f("overheadMs")` 取各分量（`:156-159`）。**原清单 O1 里写的 `transportMs` 已作废**——前端读的是 `overheadMs`。
- **B. `overheadMs` 由 Rust 端计算并写入**（= `serverMs − durationMs − auditMs`），不是前端算。语义 = 请求 JSON 解析 + 响应序列化 + gzip 压缩 + 线缆传输。这样 O2 面板直接读字段即可出堆叠条。
- **C. `task_local` 计时器 scope 必须包裹整个 `tools/call` 逻辑，`take_io()` 必须在 scope 内部调用**（`task_local` 在 scope 结束后未初始化，再 `.with()` 会 panic）。故建议把 `tools/call` 分支体抽成独立 `async fn handle_tools_call(...)`，`with_io_timer` 包裹其全部。
- **D. batch 内部 `new_entry` 调 4 个 `None`**：batch 子审计不单独计时（io 归并到 batch 外层审计的 `ioMs`）。见 §4.3。
- **E. search_files 跨 rayon 线程**：`task_local` 穿透不到 rayon worker，改用 `Arc<AtomicU64>` 在闭包内累加，`spawn_blocking` 返回后 `record_io(...)`. 见 §4.4。
- **F. `netMs`（O1-b 探针）本次不做**，仅预留 `Option` 字段（恒为 `None`）。TCP 探针（netprobe.rs + config 开关）单独排期，避免引入网络副作用与测试负担。

---

## 1. 字段契约（audit.rs）

`AuditEntry`（`audit.rs:7-19`）新增 4 个可选字段（均 `#[serde(skip_serializing_if = "Option::is_none")]`，旧日志行反序列化时缺字段 = `None`，**向后兼容**）：

```rust
#[serde(rename = "serverMs", skip_serializing_if = "Option::is_none")]
pub server_ms: Option<u64>,   // 服务端总墙钟 = t_sent − t_recv
#[serde(rename = "ioMs", skip_serializing_if = "Option::is_none")]
pub io_ms: Option<u64>,       // 实际文件读写 / 备份 / 拷贝耗时（task_local 累加）
#[serde(rename = "auditMs", skip_serializing_if = "Option::is_none")]
pub audit_ms: Option<u64>,    // 审计写盘耗时
#[serde(rename = "netMs", skip_serializing_if = "Option::is_none")]
pub net_ms: Option<u64>,      // 网络往返估算（O1-b 探针填，本次恒 None）
// 注：overheadMs 由 new_entry 派生写入，不单独存储字段——见 §3
```

> `overheadMs` 不存字段：在 `new_entry` 里由 `server_ms.saturating_sub(duration_ms + audit_ms)` 算出后写入 `overhead_ms`，避免冗余。

---

## 2. 新增 `timing.rs`（task_local 计时器，零改 handler 签名）

```rust
use std::cell::Cell;
use std::time::Duration;
use tokio::task_local;

task_local! {
    static IO_MS: Cell<u64>; // 累积毫秒
}

/// 在 handler 入口包裹整个 tools/call 处理，使内部所有 record_io 累加进本任务计时器。
pub async fn with_io_timer<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    IO_MS.scope(Cell::new(0), fut).await
}

/// 在工具的关键 fs 调用处调用：累加本次 I/O 耗时。
pub fn record_io(dur: Duration) {
    IO_MS.with(|c| c.set(c.get() + dur.as_millis() as u64));
}

/// 取走累积值并清零（必须在 with_io_timer 的 scope 内部调用）。
pub fn take_io() -> Option<u64> {
    IO_MS.with(|c| {
        let v = c.get();
        c.set(0);
        if v == 0 { None } else { Some(v) }
    })
}
```

`lib.rs` 暴露模块：`pub mod timing;`

---

## 3. `audit.rs::new_entry` 签名扩展

现有签名（`audit.rs:70-87`）：`(tool, params, success, error, source_ip, duration_ms)`。
扩展为追加 4 个 `Option<u64>`：`(tool, params, success, error, source_ip, duration_ms, server_ms, io_ms, audit_ms, net_ms)`。

`new_entry` 体内：
```rust
let duration_ms = duration_ms; // 现有
let audit_ms = audit_ms;       // 传入（本次调用包住 write_audit_log 测得）
// 派生 overhead
let overhead_ms = match (server_ms, duration_ms, audit_ms) {
    (Some(s), Some(d), Some(a)) => Some(s.saturating_sub(d + a)),
    _ => None,
};
AuditEntry {
    timestamp, tool, params, success, error, source_ip,
    duration_ms,
    server_ms, io_ms, audit_ms, net_ms,
    // overhead_ms 见下方：作为同名字段写入
}
```
> 注意：§1 字段契约要求 `overheadMs` 也出现在日志里。最简洁做法——`AuditEntry` 再加一个 `#[serde(rename = "overheadMs", skip_serializing_if="Option::is_none")] pub overhead_ms: Option<u64>`，由 `new_entry` 在构造时算出填入（不依赖调用方传）。

---

## 4. 各文件改动清单（带行号锚点）

### 4.1 `mcp/http.rs` — 抽出 `handle_tools_call` + 计时点

- **`mcp_handler` 的 `"tools/call" => { ... }` 分支（`:219-290`）** 整体抽成：
  ```rust
  pub async fn handle_tools_call(
      state: Arc<AppState>,
      source_ip: String,
      body: serde_json::Value,
  ) -> impl IntoResponse {
      let t_recv = std::time::Instant::now();
      timing::with_io_timer(async move {
          let tool_name = body.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or("");
          let arguments = body.pointer("/params/arguments").cloned().unwrap_or(json!({}));
          let start = std::time::Instant::now();
          let result = dispatch_tool(tool_name, arguments.clone(), &state).await;
          let elapsed = start.elapsed().as_millis() as u64;
          let audit_enabled = state.config.read().await.audit_enabled;

          // ---- 审计写盘单独计时 ----
          let audit_ms = if audit_enabled {
              let a0 = std::time::Instant::now();
              match &result {
                  Ok(_) => audit::write_audit_log(&state.data_dir, &audit::new_entry(
                      tool_name, &arguments.to_string(), true, None,
                      Some(source_ip.clone()), Some(elapsed),
                      None, timing::take_io(), None, None, // server_ms/audit_ms 见下
                  )).ok(),
                  Err(e) => audit::write_audit_log(&state.data_dir, &audit::new_entry(
                      tool_name, &arguments.to_string(), false, Some(e.clone()),
                      Some(source_ip.clone()), Some(elapsed),
                      None, timing::take_io(), None, None,
                  )).ok(),
              };
              Some(a0.elapsed().as_millis() as u64)
          } else { None };

          // ---- 服务端总耗时（scope 内取，因 take_io 已结束且 scope 未退出）----
          let server_ms = t_recv.elapsed().as_millis() as u64;
          // 注意：上面 write_audit_log 时 server_ms 还没算；需在 new_entry 前算好。
          // 实际顺序：先算 server_ms = t_recv.elapsed()，再构造 entry 传入。
          // （见下方"执行顺序修正"）

          match result {
              Ok(content) => Json(json!({ "jsonrpc":"2.0","id":body.get("id"),"result":content })),
              Err(e) => { state.increment_errors().await; Json(json!({...isError...})) }
          }
      }).await
  }
  ```
  **执行顺序修正（关键）**：`take_io()`、`server_ms`、`audit_ms` 三者都在 `with_io_timer` 的 `async move` 内部、所有 `record_io` 之后求值。`server_ms` 必须在 `new_entry` 调用前算出（用 `t_recv`，它从闭包外捕获）。`audit_ms` 用 `write_audit_log` 前后 `Instant` 测得，同样在闭包内。最终 `overhead_ms = server_ms − elapsed − audit_ms` 在 `new_entry` 内派生。**`take_io()` 绝对不能在 `with_io_timer(...).await` 之后调用。**

- **`mcp_handler` match 分支改为**：
  ```rust
  "tools/call" => return handle_tools_call(state, addr.ip().to_string(), body).await,
  ```
  （`addr` 已是 `ConnectInfo<SocketAddr>`，`source_ip` 在原分支 line 178 算过。）

- **`new_entry` 调用点（原 `:241-251` 与 `:266-276`）** 随上述迁移，统一补 4 个 `Option<u64>` 参数（server_ms / io_ms / audit_ms / net_ms）。

### 4.2 `mcp/tools/batch.rs` — 同步 `new_entry` 新签名

- `batch.rs:60` 与 `:62-69` 两处 `audit::new_entry(...)` 调用，**末尾补 4 个 `None`**（子审计 `server_ms/io_ms/audit_ms/net_ms` 均 `None`）。io 归并到 batch 外层审计的 `ioMs`（scope 穿透生效，见 §D）。源码扫描语义不变。

### 4.3 各工具 fs 埋点（record_io）

| 文件 | 位置（行） | 埋点 |
|---|---|---|
| `read_files.rs` | `:85` `tokio::fs::metadata`、`:94` `tokio::fs::read` | 包 `tokio::fs::read` 主读（含 metadata 亦可） |
| `write_files.rs` | `:103` `tokio::fs::write` | 包 write；备份 copy 在 `backup.rs` 内埋（见下） |
| `edit_files.rs` | `:94` `tokio::fs::read`、`:130` `write_atomic` | 包 read + `write_atomic` 内 write/rename（`:153`/`:157`） |
| `search_files.rs` | 跨线程特例，见 §4.4 | — |
| `list_directory.rs` | `:78` `read_dir`、`:91` `metadata` | 包二者（耗时小，可选但建议做） |
| `backup.rs` | `backup_before_overwrite` 内 `std::fs::copy` | **在 backup 模块内埋点**，write/edit/move/copy/delete 全部自动受益 |

埋点范例（`read_files.rs:94` 处）：
```rust
let t0 = std::time::Instant::now();
let raw = tokio::fs::read(&resolved).await.map_err(|e| format!("Read error: {e}"))?;
crate::timing::record_io(t0.elapsed());
```

`backup.rs` 内（同步函数，仍在原 tokio task 内调用，task_local 可用）：
```rust
let t0 = std::time::Instant::now();
std::fs::copy(src, dst)?;
crate::timing::record_io(t0.elapsed());
```

### 4.4 `search_files.rs` 跨线程处理（关键特例）

`search_files` 的 I/O 发生在 `spawn_blocking` 闭包内的 **rayon 线程池**（`build_parallel`，`:198-367`），`task_local` 穿透不到这些线程。方案：

1. `handle`（`search_files.rs:78`）内建 `let io_nanos = Arc::new(AtomicU64::new(0));`。
2. 把 `io_nanos.clone()` 移入 `spawn_blocking` 闭包，在文件读取点累加：
   - `:259` `std::fs::File::open`（files_with_matches）
   - `:287` `std::fs::File::open`（count）
   - `:315` `std::fs::read_to_string`（content）
   每处：
   ```rust
   let t0 = std::time::Instant::now();
   let r = std::fs::read_to_string(path); // 或 File::open
   io_nanos.fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
   let content = r?;
   ```
3. `spawn_blocking` 返回后（`search_files.rs:135` `.await` 之后），在原 tokio task 内：
   ```rust
   crate::timing::record_io(std::time::Duration::from_nanos(io_nanos.load(Ordering::Relaxed)));
   ```
   此刻已回到 `with_io_timer` 的 scope 内（因为 `search_files::handle` 是从 `dispatch_tool` 内部调用的，而 `dispatch_tool` 在 scope 内），`record_io` 正常累加。`✓`

---

## 5. O1-b 网络 RTT 探针（本次不做，仅预留）

`net_ms` 字段已加（`Option`，恒 `None`）。TCP 探针（`netprobe.rs` + `AppState` 基线字段 + `config.rs`/`db.rs` 新增 `net_probe_enabled` 默认 `false`）列入后续独立排期，不在本 O1 范围内。O1 落地后，若 `net_ms` 为 `None`，O2 面板的"网络往返"条为 0/缺省，结论标注"网络分量需开启探针"。

---

## 6. 测试策略

1. **`timing.rs` 单测**：
   - `record_io` 多次累加正确；`take_io` 返回累计值并清零；scope 之间隔离（A scope 的累加不影响 B）。
   - 边界：`take_io` 在零值返回 `None`。
2. **向后兼容单测**：用一条无新字段的旧 `AuditEntry` JSON 行喂 `serde_json::from_str`，断言新字段全为 `None`、旧字段正常。
3. **集成测试（扩展 `tests/perf_real.rs` 思路）**：真起 server，打一次 `read_files`，读 `data_dir/audit.log` 末行，断言含 `serverMs`/`ioMs`/`auditMs`/`overheadMs` 且均为合理正数（io>0、overhead>=0）。
4. **回归**：`cargo test --lib`（现有 58 单测须全绿）+ `cargo test --test perf_real`（4 个真实测试须全绿）。

---

## 7. 验证步骤

1. `cargo build` 干净通过。
2. `cargo test --lib` —— 58 原有 + timing 新单测全绿，无回退。
3. `cargo test --test perf_real` —— 4 个真实测试全绿（gzip / batch 合并 / batch 审计 / 只读拦截）。
4. 手动：启动真实 server，远程 Claude Code 跑一轮真实任务，查看 `audit.log` 新字段分布。
5. **O1 的终极价值**：用真实 `audit.log` 数据复跑 `tools/audit_stats.py`（或 O2 面板堆叠条），验证：gzip 后 `overheadMs` 显著下降、batch 使用下 `serverMs` 不再因多次往返线性叠加 —— 这正是量化 ①+② 收益的方法论（上次靠数据纠正误判的延续）。

---

## 8. 回滚与风险

- **风险极低，纯观测**：新字段全 `Option` + `skip_serializing_if`，不影响任何既有逻辑、安全约束（白名单/canonicalize/Bearer 常量比较/限流/只读拦截）、DB schema、前端（已兼容）。
- **唯一 panic 陷阱**：`take_io()` 在 `with_io_timer` scope 外调用会 panic（task_local 未初始化）。方案 §3/§4.1 已强制 `take_io` 在闭包内；测试 1 覆盖。
- **回滚**：git revert 本次改动即可，无数据迁移。旧 `audit.log` 行仍可被新代码解析（`None` 字段）。

---

## 9. 与 O2 面板的衔接（已就绪，零前端改动）

`PerfCharts.tsx:145-159` 已实现条件分支：当 `serverMs != null` 自动渲染「单次调用耗时拆解」堆叠条，取 `durationMs`(调度)/`ioMs`(读写)/`auditMs`(审计)/`netMs`(网络)/`overheadMs`(传输)。O1 落地后该条自动生效，**前端无需任何改动**。

---

## 10. 执行顺序建议

1. `audit.rs`：加 5 字段 + 扩 `new_entry`。
2. `timing.rs`：新建 + `lib.rs` 暴露。
3. `http.rs`：抽 `handle_tools_call` + 计时点 + 迁移 `new_entry` 调用。
4. `batch.rs`：补 `new_entry` 4 个 `None`。
5. 各工具埋点（read/write/edit/backup/search/list）。
6. 单测 + 集成测试 + 全量验证。
7. （可选）真实 `audit.log` 数据复跑，量化 gzip+batch 收益。
