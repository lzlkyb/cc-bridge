# run_command.rs 安全补丁草案（危险命令拦截）

> 来源：`rustterm-mcp` 的 `execute_command` 安全模型
> 仓库：github.com/bangrocket/rustterm-mcp（基于官方 `rmcp` SDK）
> 目标文件：`desktop/src-tauri/src/mcp/tools/run_command.rs`

## 现状核对

- `run_command.rs` **已有** `timeout_ms`（轮询 `try_wait` + deadline 实现超时强杀）和 `max_output_bytes`（截断）。
- **缺失**：危险命令拦截。任何开启 `shell_enabled` 的调用方都能执行 `rm -rf /`、`mkfs`、fork bomb 等毁灭性命令。这是 D 组安全债（命令注入 / 沙箱）的核心缺口。

## 提炼自 rustterm-mcp 的模式

```rust
const DANGEROUS_COMMANDS: &[&str] = &["rm -rf /", "rm -rf /*", "mkfs", ":(){:|:&};:"];

fn is_dangerous_command(command: &str) -> bool {
    let normalized = command.to_lowercase();
    DANGEROUS_COMMANDS.iter().any(|&dangerous| normalized.contains(dangerous))
}
```

在 `execute_command` 入口：

```rust
// Security check
if Self::is_dangerous_command(&req.command) {
    return Ok(CallToolResult::error(vec![Content::text(
        "Error: This command has been blocked for safety reasons.",
    )]));
}
```

---

## 建议落地到 cc-bridge 的 diff 草案

### 1) 在 `run_command.rs` 顶部新增常量与函数

（放在 `default_max_output_bytes` 附近，约第 33 行之后）

```rust
/// 危险命令黑名单（对齐 rustterm-mcp 安全模型）。
/// 采用子串匹配（to_lowercase 后 contains），是低成本第一道闸。
const DANGEROUS_COMMAND_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "mkfs",
    ":(){:|:&};:", // fork bomb
];

/// 命中任一危险模式即返回 true。
/// 注意：这是启发式黑名单——`echo "rm -rf /"` 会误伤，`rm -rf /home` 不会拦。
/// 二期建议升级为命令白名单或 shell 令牌化解析（见文末）。
fn is_dangerous_command(command: &str) -> bool {
    let normalized = command.to_lowercase();
    DANGEROUS_COMMAND_PATTERNS
        .iter()
        .any(|d| normalized.contains(*d))
}
```

### 2) 在 `handle()` 的 `shell_enabled` 检查之后、`resolve_safe_path` 之前插入拦截

（对应文件第 64 行 `}` 之后、第 65 行 `let resolved_cwd = ...` 之前）

```rust
    if is_dangerous_command(&args.command) {
        return Err(
            "命令被安全策略拦截：命中危险模式（如 rm -rf /、mkfs、fork bomb）。\
             如确有必要，请在面板『命令白名单』中显式授权，或改用安全等价写法。"
                .to_string(),
        );
    }
```

### 3) 新增单测（放在 `#[cfg(test)] mod tests` 内）

```rust
    /// 危险命令必须被拦截，且不进入 cwd 白名单解析、不注册到运行表。
    #[tokio::test]
    async fn dangerous_command_blocked_before_spawn() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let result = handle(
            RunCommandArgs {
                command: "rm -rf /".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
            },
            &state,
        )
        .await;
        let err = result.expect_err("危险命令必须被拦截");
        assert!(
            err.contains("安全策略"),
            "应提示被安全策略拦截，实际：{err}"
        );
        assert!(state.running_commands.is_empty());
    }
```

---

## 已知局限与后续加固建议

- 当前为**子串黑名单**，误伤 / 漏拦并存（rustterm-mcp 同款）。建议二期：
  - 改为**命令白名单**（仅放行 `git` / `cargo` / `npm` / `node` / `dotnet` 等显式许可的二进制）+ 参数级约束；
  - 或做 shell 令牌化解析，对 `rm -rf` 单独校验路径是否落在 `allowed_roots` 内；
  - 对齐 rustterm-mcp 的 `MAX_FILE_SIZE = 10MB` 到文件类工具（我们已有 `max_file_size_bytes`，命令输出已有 `max_output_bytes`）。
- 超时已具备；可考虑把默认 `timeout_ms` 从 30s 提到与 litecode 一致的 120s，并显式 clamp 上限（litecode 上限 600s）。
- 可顺带加 `description` 字段（litecode Bash 有），用于命令审计 / 权限 UX，落库到 `command_history` 类结构。
