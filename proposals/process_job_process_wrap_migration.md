# process_job.rs → process-wrap 迁移 diff 方案

> 目标：用 `process-wrap`（watchexec 出品，`command-group` 官方后继）的 `JobObject` 包装器
> 替换我们手写的 `win32job` 逻辑（`process_job.rs` + `run_command.rs` 中的 `create_and_assign` 调用）。
> 仓库参考：github.com/metatypedev/process-wrap、github.com/watchexec/command-group

## 为什么

- 我们 `process_job.rs` 手写的 `Job::create()` + `set_extended_limit_info(kill_on_job_close)`
  + `assign_process` 与 `command-group` 的 Windows 实现**同构**（已核对 `command_group/stdlib/windows.rs`：
  `job_object(kill_on_drop)` → `assign_child` → `GroupChild`）。
- `process-wrap` 额外带来：
  - **跨平台**：POSIX 用 `ProcessGroup::leader()`，我们若将来支持 Linux/macOS 无需另写；
  - **社区充分测试**（watchexec 生态，CI 覆盖 Windows/Linux/macOS）；
  - **关键正确性改进**——`JobObject` 包装器内部会先把子进程以 `CREATE_SUSPENDED` 启动、
    挂入 Job 后再 resume，**消除了我们"先 `spawn` 再 `assign`"存在的竞态窗口**
    （孙进程可能在挂载前已 fork 出来而漏杀）。
- 旁证：litecode 的 `process.rs` 仅用 `child.kill()`（**无 Job Object**），存在孙进程孤儿泄漏；
  我们当前方案已优于它。迁移到 process-wrap 是在保持正确性的同时，**消除自写 Win32 代码**。

## 工具链兼容性

- process-wrap 9.x MSRV **1.87**；本机 `rustc 1.96.0` ✅（已 `rustc --version` 核实）。
- 我们用的是同步 `std::process::Command`（在 `spawn_blocking` 内），故采用 **std 前端**
  `process_wrap::std::CommandWrap`。

---

## 逐文件 diff 方案

### A. `Cargo.toml`

```toml
# 新增
process-wrap = { version = "9", features = ["std"] }
# win32job 可在切到 process-wrap 并验证后移除
```

> `std` 前端；`job-object` / `creation-flags` 为默认开启，无需显式写 feature。

### B. `run_command.rs` `spawn_shell` —— 替换手动建 job 段落

原代码（约第 113–130 行）：

```rust
let mut cmd = Command::new("cmd");
cmd.args(["/C", command]);
cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
cmd.stdout(Stdio::piped());
cmd.stderr(Stdio::piped());
cmd.current_dir(resolved_cwd);
let child = cmd.spawn().map_err(|e| format!("启动命令失败: {e}"))?;
let raw_handle: RawHandle = child.as_raw_handle();
if raw_handle.is_null() {
    return Err("命令刚启动就已退出，无法获取进程句柄".to_string());
}
let job = process_job::create_and_assign(raw_handle as isize)?;
```

改为：

```rust
use process_wrap::std::*;

let mut wrapped = CommandWrap::with_new("cmd", |cmd| {
    cmd.args(["/C", command]);
    cmd.current_dir(resolved_cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
});
// CreationFlags 必须在 JobObject 之前（process-wrap 要求，
// 或 CreationFlags 内含 CREATE_SUSPENDED）。JobObject 内部会设 KillOnJobClose。
#[cfg(windows)]
wrapped.wrap(CreationFlags(CREATE_NO_WINDOW));
#[cfg(windows)]
wrapped.wrap(JobObject);
#[cfg(not(windows))]
wrapped.wrap(ProcessGroup::leader());

let child = wrapped
    .spawn()
    .map_err(|e| format!("启动命令失败: {e}"))?;
// child: process_wrap::std::Child —— drop 即触发 KillOnJobClose 整树终止。
// 不再需要手动持有 job，job 生命周期绑定在 child 上。
```

> 注：`CommandWrap::spawn()` 返回的 `Child` 镜像 `std::process::Child`
> （`.stdout()` / `.stderr()` / `.id()` / `.kill()` / `.wait()` / `.try_wait()` 均可用），
> 所以 `run_foreground` / `spawn_background` 对 child 的操作基本不变。

### C. `run_command.rs` `run_foreground` / `spawn_background` 签名

- 去掉 `job: win32job::Job` 参数（原第 194、250 行）。
- `run_foreground`：正常结束直接 `drop(child)`（child 内含 job，drop 即整树终止）；
  超时分支 `child.kill()` 后 drop。
- `spawn_background`：把 `child`（wrapped）存入 `RunningCommand`，而非存 `job`。

### D. `state.rs` `RunningCommand`

```rust
// 旧
pub job: win32job::Job,
// 新
pub child: process_wrap::std::Child,
```

> 后台任务存活期间持有 wrapped child；`stop_command` 时 `child.kill()` 并 drop → 整树终止。
> stdout/stderr 缓冲（Arc<AsyncMutex<Vec<u8>>>）保持不变，仍按 offset 切片返回。

### E. `stop_command.rs` / `get_command_output.rs`

- 引用 `running.job` 的地方改为对 `running.child` 操作（`child.kill()` + drop）。
- `get_command_output` 的 stdout/stderr 切片逻辑不变。

### F. `process_job.rs`

切到 process-wrap 并通过 `cargo test` 后，可**删除本文件**及其 `#[ignore]` 测试
（原 `create_and_assign_self_succeeds` 等因 KillOnJobClose 自伤 test runner 的坑也随之消失）。

---

## 验证清单

1. `cargo test --lib`（此前 process_job 两个自伤测试已 `#[ignore]`，迁移后整文件删除，
   不再有 `cargo test` 静默中断、且因终止码 0 被误判通过的风险）。
2. 真实 exe 测试 `foreground_real_exe_returns_stdout`（hostname）仍过。
3. 后台 `background_registers_with_handle` 仍过；`stop_command` 能终止含孙进程的任务。
4. `cargo clippy --lib` 零警告。

## 风险 / 注意点

- wrapped `Child` **必须**被 `RunningCommand` 持有（后台任务），否则提前 drop 会让 job 过早关闭、误杀进程。务必确认所有权转移正确。
- `CreationFlags` 与 `JobObject` 的 `.wrap()` 顺序**不可颠倒**（docs 明确要求 CreationFlags 在前，或含 CREATE_SUSPENDED）。
- 我们当前 `CREATE_NEW_PROCESS_GROUP` 可去掉：Job Object 已接管进程组 / 整树终止语义；且 `CREATE_NO_WINDOW` 下本无控制台事件需要隔离。
