# Bash 执行升级实施方案（借鉴 Claude Code 主 Bash 工具）

> 调研来源：本机 `D:/AItool/aiwork/claude-code-main`（claude-code 派生实现）。
> 关联文档：`proposals/session_cwd_persistence_rfc.md`（概念 RFC）、`docs/benchmark-vs-native-claude-code.md`（对标分析）。
> 目标：把 cc-bridge `run_command` 从「裸 `cmd /C` 无状态」升级为「可切换 bash + cwd 持久化追踪」，且**不削弱**现有安全围栏（路径白名单 / 鉴权 / 限流）。

---

## 0. 关键结论（先说重点）

**之前方案的修正**：原 `session_cwd_persistence_rfc.md` 把「常驻 shell 会话」作为 cwd 持久化的主路径。读源码后发现——

> **Claude Code 主 Bash 工具每条命令都 `spawn` 全新 shell 进程（无状态），`cwd` 持久化靠 `pwd -P >| $cwdFile` 写入临时文件、命令结束后读回状态。**

证据（`src/utils/Shell.ts:179` 注释「Creates a new shell process for each command execution」；`src/utils/shell/bashProvider.ts:186` 末尾 `pwd -P >| $cwdFilePath`；`Shell.ts:387` 命令完成后 `readFileSync(cwdFilePath)` 回写 `setCwdState`）。源码中**无任何 session 复用 / keepAlive / persistent** 机制。

**因此：cc-bridge 默认路径 = 无状态 + pwd 文件追踪，而不是常驻 shell。**
理由：cc-bridge 安全模型依赖「每条命令独立 `resolve_safe_path(cwd)` 重校验白名单」。常驻 shell 一旦 `cd` 出白名单区，服务端无法在每条命令前重校验——这正是 RFC 自己点出的风险。pwd 文件法在保留逐条隔离的同时实现 cwd 持久化，**两全**。

---

## 1. Claude Code 的 Bash 到底怎么做的（可借鉴点逐条）

### 1.1 执行模型（核心）
- `exec(command, abortSignal, shellType, opts)`（`Shell.ts:182`）每次**新建进程**，`spawn(binShell, ['-c', commandString], …)`。
- shell 类型抽象为 `ShellProvider`（`shellProvider.ts`）：`bash` / `powershell`，各自实现 `buildExecCommand` / `getSpawnArgs` / `getEnvironmentOverrides`。**这正是 cc-bridge 缺的抽象层**。
- `findSuitableShell`（`Shell.ts:74`）：`which('bash')` → 常见路径 `/bin /usr/bin /usr/local/bin /opt/homebrew/bin` → 尊重 `SHELL` / `CLAUDE_CODE_SHELL`。cc-bridge 的 `bash.exe` 探测可对齐此思路（Windows 下加 `C:\Program Files\Git\bin\bash.exe` 等）。

### 1.2 cwd 持久化（pwd 文件法，最高价值）
包裹命令（`bashProvider.ts:156-187`）：
```bash
source <snapshot> 2>/dev/null || true      # 恢复会话级环境快照
<session env script>                          # /env 设置的会话变量
shopt -u extglob 2>/dev/null || true          # 安全：关扩展通配，防恶意文件名事后扩展
eval <quotedCommand>                          # 执行用户命令（二次解析使 alias 可用）
pwd -P >| <cwdFilePath>                        # ★ 把物理 cwd 写入临时文件
```
- `cwdFilePath` 在 **bash 内用 POSIX 路径**（`claude-<id>-cwd`），**Node 侧用 native Windows 路径**（`windowsPathToPosixPath` / `posixPathToWindowsPath` 双向转换，`Shell.ts:382`）。
- 命令完成后 `readFileSync(cwdFilePath)` → `setCwdState(newCwd)`（`Shell.ts:397-412`），并触发 `onCwdChangedForHooks`。
- 仅前台任务更新 cwd（后台任务 `backgroundTaskId` 存在时不回写）。

### 1.3 环境快照（`ShellSnapshot.ts`）
- 会话启动 `createAndSaveSnapshot(shellPath)` 捕获一份环境，之后每条命令 `source` 它（若有）。保证跨命令环境一致、不随交互漂移。
- 快照文件丢失时 `access()` 探测失败 → 回退 `bash -l`（login shell 初始化，`getSpawnArgs:201`）。

### 1.4 安全加固
- **disable extglob**：防止白名单校验通过后，恶意文件名在 shell 展开期被扩展（bash/zsh 分别处理，`bashProvider.ts:39`）。
- **cwd 消失恢复**：`realpath(cwd)` 失败（命令删了自己 cwd，如清临时目录）→ 回退 `getOriginalCwd()`（`Shell.ts:222`）。
- **`2>nul` → `/dev/null` 防御重写**：模型偶发写 Windows cmd 风格重定向，在 POSIX bash 下会生成名为 `nul` 的保留设备文件破坏 git，`rewriteWindowsNullRedirect` 修正（`bashProvider.ts:127`）。

### 1.5 输出与生命周期
- **文件模式输出**：`stdout`/`stderr` 直接重定向到文件 fd（`stdio: ['pipe', outputHandle.fd, outputHandle.fd]`），子进程写盘、**无 JS 参与**；大输出落盘，进度靠 tail 文件（`Shell.ts:303-315`，含 Windows `O_NOFOLLOW` 防 symlink 攻击、MSYS/Cygwin 句柄权限细节注释）。
- **treeKill 整进程树**：`treeKill(pid, 'SIGKILL')`（`ShellCommand.ts:340`），等价 cc-bridge 的 `JobObject`（Windows 下 JobObject 更彻底）。
- **尺寸看门狗**：后台命令每 5s 轮询输出文件大小，超 `MAX_TASK_OUTPUT_BYTES` 直接 SIGKILL，防卡死的 append 循环写爆磁盘（`ShellCommand.ts:239`）。
- **超时自动转后台**：`shouldAutoBackground` 时超时不再 kill，而是 `background()` 转为后台任务，模型可见部分输出（`ShellCommand.ts:135`）。
- **AbortSignal 中断**：用户提交新消息（`'interrupt'` reason）不杀进程、交由调用方转后台；其余 abort 才 kill（`ShellCommand.ts:186`）。

---

## 2. cc-bridge 当前状态（对照）

`desktop/src-tauri/src/mcp/tools/run_command.rs`：
- `spawn_shell`（~212 行）：`StdCommandWrap::with_new("cmd", |c| c.args(["/C", command]))`，`stdin(Stdio::null)`，`Stdio::piped()`，`CreationFlags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)`，`JobObject`。
- 安全：① `shell_enabled` 开关 → ② 危险命令子串过滤 → ③ `resolve_safe_path(cwd)` 白名单。
- 输出：**专用 OS 线程读 pipe + `max_output_bytes` 截断**（`run_command.rs:661` 注释，原用 portable-pty 因 ConPTY 握手卡死改 pipe）。
- **无状态**：cwd 每次必传，env/cd 不跨调用。

可复用的中立封装（**一行不用动**）：`StdCommandWrap` 进程管道、`JobObject`、`CreationFlags`、`Stdio::piped/null`、`spawn_blocking`、输出线程。只换「被 spawn 的可执行文件 + 参数形态」即可。

---

## 3. 借鉴映射（cc-bridge 该借什么）

| 借鉴点 | 价值 | 改动面 | 阶段 |
|---|---|---|---|
| **cwd 持久化（pwd 文件法）** | 高（闭 RFC 头号缺口 🟡2，且不削弱白名单） | 中：包裹命令 + 读回 cwd + 白名单 re-validate | P1+ |
| **shell 类型抽象层 `ShellProvider`** | 高（cmd/bash 可切换、零回归） | 中：抽 trait + 两个 impl | P1 |
| **bash.exe 探测 + 默认回退 cmd** | 高（Phase 1 主体） | 低：启动探测 | P1 |
| **`MSYS_NO_PATHCONV=1` + cwd POSIX 传入** | 高（解决 Windows 路径坑） | 低：env 注入 + 路径转换 | P1 |
| **disable extglob** | 中（安全加固） | 低：bash 包裹加一句 | P1 |
| **环境快照 session-level** | 中（环境一致性） | 中：启动时 `bash -c env` 存档 + source | P2 |
| **文件模式输出（fd 直写）** | 中（大输出性能） | 中：改 stdio 重定向 + 读回 | P2 |
| **尺寸看门狗（后台）** | 中（防磁盘写爆） | 低：轮询输出文件大小 | P2 |
| **超时自动转后台** | 中（体验） | 中：超时 handler 转 background | P2 |
| **cwd 消失恢复** | 低（边界） | 低：realpath 失败回退 | P2 |
| **`2>nul`→`/dev/null` 防御** | 低（模型写 bash 后几乎不需） | 低 | P3 |

> **已否决**：常驻 shell 会话（Arbitrium/sshmcp 式 `session_id` 复用）作为默认路径——会破坏逐条白名单重校验。仅作为未来「可信本机模式」的可选高级变体保留，不在本期。

---

## 4. 推荐落地方案

### Phase 1 — 可切换 bash + cwd 持久化（默认仍 cmd，零回归）
1. **抽 `ShellProvider` trait**：`build_exec_command(&self, cmd, opts) -> (command_string, cwd_file_path)`、`spawn_args(&self) -> Vec<String>`、`env_overrides(&self) -> HashMap`、`shell_path()`。实现 `CmdProvider`（`/C`）与 `BashProvider`（`-c`）。
2. **`config.rs` 加 `shell_type: "cmd" | "bash"`**（默认 `"cmd"`）。
3. **`BashProvider` 实现**：
   - 包裹：`{ shopt -u extglob 2>/dev/null || true; } && eval '<quoted>' && pwd -P >| <cwdFile>`（`eval` 使 alias 可用，引号同 CC 二次解析）；
   - 注入 `MSYS_NO_PATHCONV=1`；
   - cwd 转 POSIX（`/c/Users/...`）经 `current_dir()` 传入（Windows API 级，能进目录）；
   - cwdFile 路径：给 bash 用 POSIX，Rust 侧用 native 读。
4. **启动探测 `bash.exe`**：`C:\Program Files\Git\bin\bash.exe` / `...\usr\bin\bash.exe` / `where bash`；找不到则禁用 bash 选项、面板提示。
5. **cwd 回写**：命令成功结束（非后台、非 preventCwd）后 `std::fs::read_to_string(cwdFile)` → `resolve_safe_path(new_cwd)` **重校验白名单** → 通过才更新 session cwd。
6. **工具描述动态措辞**（`registry.rs:158`）：按实际 shell 说明语法（cmd vs bash，cwd 用绝对路径 / `/c/...`）。
7. **测试守卫**：cmd 默认路径全保留；bash 路径补 `echo`/`ls`/`pwd` 用例；cwd 持久化用例（连发两条，第二条不带 cd 应仍在新 cwd）。

### Phase 2 — 输出/生命周期增强（可选，性能与体验）
- 文件模式输出（fd 直写，替 pipe 线程）；尺寸看门狗；超时自动转后台；环境快照；cwd 消失恢复。

---

## 5. 风险与对照
- **路径**：用 CC 同款「bash 内 POSIX、Rust 侧 native」双向转换 + `MSYS_NO_PATHCONV=1`，干净解决 MSYS 路径篡改。
- **安全不削弱**：每条命令仍新 spawn → `resolve_safe_path` 逐条跑；pwd 回写 cwd 前**再做一次白名单校验**，越界则忽略本次 cwd 变更。
- **回归**：默认 cmd 时行为完全不变（CmdProvider 输出与现 `cmd /C` 字节级一致），现有 15+ 测试全保留。
- **依赖**：cmd 零外部依赖；bash 需 Git for Windows，探测不到则降级，不影响 cmd 路径。

---

## 6. 下一步
按项目规则（规则 1 先出方案再动手），待你确认：
- 是否照「Phase 1 可切换 bash + pwd 文件法 cwd 持久化、默认 cmd、零回归」推进？
- Phase 2 输出增强是否纳入本期，还是留待下轮？

确认后我出详细 diff 级实施方案（含 `ShellProvider` trait 签名、`BashProvider` 完整实现、cwdFile 生命周期、测试清单）再动手。

---

## 7. 详细实现设计（diff 级，已读 `run_command.rs`/`config.rs`/`registry.rs`/`http.rs`/`state.rs` 全貌）

### 7.1 关键约束（来自现有代码）
- `session_cwd_enabled` 已存在：开启时 `cwd_sessions: DashMap<String, CwdSession{cwd, last_active}>`；`handle` 解析 `session_id`、复用/新建 session，命令**无状态** spawn。
- `CwdSession.cwd` 当前只存「用户传入 cwd」，**命令内 `cd` 不回写** → 本次升级目标。
- 默认关（`session_cwd_enabled=false`）时 `effective_session_id=None`、命令原样 `cmd /C` 透传 → **所有新行为都藏在 `effective_session_id.is_some()` 之后，现有 15+ 测试零回归**。
- `run_foreground` 当前返回 `Result<Value,String>`；`spawn_background` 注册 `running_commands`；`get_command_output` 读 `Arc<AsyncMutex<Vec<u8>>>` 增量 → 改文件模式会牵动它。

### 7.2 config.rs
新增字段（默认 `"cmd"`）：
```rust
/// 命令执行壳层："cmd"（默认，零外部依赖）或 "bash"（Git Bash，需 Git for Windows）。
/// 仅影响 run_command/stop_command 的壳层；安全围栏（白名单/鉴权/限流）与 shell 无关。
pub shell_type: String,
```
- `Default`: `shell_type: "cmd".into()`
- 解析：`"shell_type" => config.shell_type = parse_or_warn(key, value, "cmd".into())`（校验非 cmd/bash 时回退 cmd）
- `to_value` 映射补 `"shell_type"` 行。
- （可选）env `CC_BRIDGE_SHELL` 覆盖 bash 路径留待后续，本期仅自动探测。

### 7.3 新模块 `mcp/tools/shell.rs`（壳层抽象，对应 CC `ShellProvider`）
```rust
pub enum ShellType { Cmd, Bash }
pub fn parse_shell_type(s: &str) -> ShellType { /* "bash" => Bash, 其它 => Cmd */ }

// bash.exe 探测（OnceLock 缓存，避免每条命令 spawn where）
static BASH_EXE: OnceLock<Option<PathBuf>> = OnceLock::new();
pub fn detect_bash_exe() -> Option<PathBuf> { /* 候选路径 + `where bash` 兜底 */ }

// C:\Users\foo -> /c/Users/foo（去 \\?\ 前缀）
pub fn windows_to_posix(p: &Path) -> String { ... }

// 单引号转义（对齐 CC eval 包裹）：' -> '\'' 再整体包 '
fn sh_quote(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    pub env_extra: Vec<(String, String)>,
    /// 传给 Rust 侧读回用的**原生**路径；bash 内部用其 POSIX 形式写 pwd。
    pub cwd_capture_file: Option<PathBuf>,
}

/// track_cwd = effective_session_id.is_some()（仅会话内才持久化有效 cwd）
pub fn build_invocation(shell: ShellType, command: &str, native_cwd: &Path, track_cwd: bool) -> Invocation {
    let cwd_file = track_cwd.then(|| std::env::temp_dir().join(format!("cc-bridge-cwd-{:016x}", rand::random::<u64>())));
    match shell {
        Cmd => match &cwd_file {
            None => Invocation { program:"cmd".into(), args:vec!["/C".into(), command.into()], ..default },
            // 会话内：命令成功才写 cwd（&& 短链），best-effort
            Some(f) => Invocation { program:"cmd".into(), args:vec!["/C".into(), format!("{command} && cd > \"{}\"", f.display())], cwd_capture_file: Some(f.clone()) },
        },
        Bash => {
            let quoted = sh_quote(command);
            let prefix = "{ shopt -u extglob 2>/dev/null || true; }";
            let body = format!("{prefix} && eval {quoted}");
            let (args, file) = match &cwd_file {
                None => (format!("{body}"), None),
                // 会话内：再加 pwd -P 写文件（POSIX 路径给 bash）
                Some(f) => {
                    let posix = windows_to_posix(f);
                    (format!("{body} && pwd -P >| {posix}"), Some(f.clone()))
                }
            };
            Invocation { program: detect_bash_exe()?.to_string_lossy().into_owned(),
                         args: vec!["-c".into(), args],
                         env_extra: vec![("MSYS_NO_PATHCONV".into(), "1".into())],
                         cwd_capture_file: file }
        }
    }
}
```
- bash 探测失败：`detect_bash_exe()` 返回 None → `build_invocation` 无法构造 program → 调用方 `spawn_shell` 直接 `Err("bash 不可用：未检测到 Git for Windows 的 bash.exe，请将 shell_type 改回 cmd 或安装 Git for Windows")`。

### 7.4 run_command.rs 改动
- `handle`：
  - 读 `let shell = parse_shell_type(&config.shell_type);`（config 锁内）
  - `let track_cwd = effective_session_id.is_some();`
  - `let cwd_file = if track_cwd { temp... } else { None };`（也可在 build 内造，这里统一造以便回读）
  - 透传给 `spawn_blocking` → `spawn_shell(... shell, track_cwd, cwd_file)`，返回 `(Value, Option<PathBuf>)`。
  - 返回后：`if track_cwd { if let (Some(sid), Some(new_cwd)) = (&effective_session_id, new_cwd) { if let Ok(resolved) = resolve_safe_path(&new_cwd, &allowed_roots, whitelist) { if let Some(mut s) = cwd_sessions.get_mut(sid) { s.cwd = resolved; s.last_active = Instant::now(); } } } }` —— **白名单重校验后才回写**（规则 7 不削弱）。
  - 再 `inject_session_info(result, effective_session_id, &resolved_cwd)`。
- `spawn_shell` 签名加 `shell: ShellType, track_cwd: bool, cwd_file: &Path`，返回 `Result<(Value, Option<PathBuf>), String>`。内部：
  - `let inv = build_invocation(shell, command, resolved_cwd, track_cwd);`（bash 探测失败 → Err）
  - 替换硬编码 `StdCommandWrap::with_new("cmd", |c| c.args(["/C", command]) ...)` 为：
    ```rust
    let mut cmd = StdCommandWrap::with_new(&inv.program, |c| {
        c.args(&inv.args);
        c.stdin(Stdio::null());
        c.stdout(Stdio::piped());
        c.stderr(Stdio::piped());
        c.current_dir(resolved_cwd); // 原生 C:\...，Git Bash 启动即落在 /c/...
        for (k,v) in &inv.env_extra { c.env(k, v); }
    });
    cmd.wrap(CreationFlags(...)); cmd.wrap(JobObject);
    ```
  - `background` → `spawn_background(...).map(|v| (v, None))`
  - `foreground` → `run_foreground(child, timeout_ms, max_output_bytes, track_cwd, cwd_file).map(|(v,cwd)| (v,cwd))`
- `run_foreground` 签名加 `track_cwd: bool, cwd_file: &Path`，返回 `Result<(Value, Option<PathBuf>), String>`：
  - `Some(status)` 分支：读输出后，若 `track_cwd`，`std::fs::read_to_string(cwd_file)` → `trim()` → `Some(PathBuf::from(new))`（文件不存在/读失败 → None，不更新）。返回 `(text_result(...), new_cwd)`。
  - `None`（超时）分支：保留杀整树逻辑，返回 `(json, None)`。**（Phase 2 超时自动转后台在此改，见 7.6）**
- 注释更新：`spawn_shell` 顶部注释改为「cmd 或 bash，按 shell_type 选择；无状态，cwd 持久化经 cwd 文件回写 session」。

### 7.5 registry.rs / http.rs（措辞）
- `registry.rs:158` 工具描述改为壳层无关 + 提示 bash 选项：
  > "Execute a shell command in a whitelisted cwd. The shell is `cmd` by default; if the operator set `shell_type=bash` in config, commands run in Git Bash — use POSIX `/c/...` paths and bash syntax (jq/find/pipes). DANGEROUS: ... Foreground ... Background ... If session cwd persistence is enabled, pass `cwd` once to get a `sessionId`; later pass that `sessionId` to keep working in the same directory — `cd` inside a command now carries over to the next call (re-validated against the whitelist each time)."
- `http.rs:255` instructions 末尾补一句：「命令执行支持 cmd 与 Git Bash（取决于 shell_type 配置）。」

### 7.6 Phase 2 纳入本期（除 file-mode 输出外）
- **(a) cwd 消失恢复**：`handle` 中 `resolve_safe_path` 后若 `!resolved_cwd.exists()`（命令删了自己 cwd 场景），回退到第一个存在的 `allowed_root`；都没有才报错（对齐 CC `Shell.ts:222`）。
- **(b) 超时自动转后台**：`run_foreground` 超时分支不再 `start_kill`，而是把 child 转入 `spawn_background` 逻辑（注册 `running_commands`、返回 handle），让模型可见部分输出（对齐 CC `shouldAutoBackground`）。返回值带 `handle` + `timedOut:true` 标记。
- **(c) bash 环境快照**：首次用 bash 时 `bash -c 'env'` 捕获快照到临时文件，`build_invocation` 在 bash 包裹头部加 `source <snapshot> 2>/dev/null || true`（对齐 CC `ShellSnapshot`）。快照文件丢失 → 不加（回退无快照）。
- **(d) 后台尺寸看门狗**：`spawn_background` 起一个监控线程，定期查 buffer 长度，超硬上限（如 `max_output_bytes*4` 或 16MB）则 `start_kill` 整树，防失控后台进程占内存（pipe 模式内存已被 max_output_bytes 截断，此看门狗兜底极端场景）。

### 7.7 测试清单
- 现有 cmd 测试（15+）**全部保留、预期不变**（默认/无会话路径命令原样透传）。
- 新增：
  - `bash_detection_falls_back_when_no_git`：mock/无 bash 时 `shell_type=bash` 调用返回 Err 含「bash 不可用」（用 cfg 或跳过若本机有 git）。
  - `bash_echo_returns_stdout`：`shell_type=bash` + `echo hello` → stdout 含 hello（本机有 Git 才跑，否则 `#[ignore]`）。
  - `bash_session_cwd_persists`：`session_cwd_enabled=true` + `shell_type=bash`，第一次 `cd subdir && pwd`，第二次仅 `session_id` + `pwd` → 输出为 subdir（验证 `cd` 跨调用持久化 + 回写）。
  - `bash_extglob_disabled`：构造恶意文件名场景验证 extglob 已关（可选，低优）。
  - `cwd_persistence_skipped_when_whitelist_fails`：bash 会话内 `cd /outside/whitelist` 后，session cwd 不应被更新为越界路径（白名单重校验生效）。

---

## 8. 范围调整建议：file-mode 输出（fd 直写）延后单独 PR
- 原 Phase 2 含「stdout/stderr 直写文件 fd、子进程写盘无 JS 参与」（CC `Shell.ts:303`）。
- **延后理由**：cc-bridge 当前 `get_command_output` 依赖内存 `Arc<AsyncMutex<Vec<u8>>>` 做增量读取；改文件模式需同步改 `get_command_output.rs` 的读取路径（从文件 offset 读），且破坏 `running_commands` 里 `stdout: Arc<AsyncMutex<Vec<u8>>>` 字段结构，牵动面大、回归风险高。
- **当前 pipe 模式已够用**：后台输出内存已被 `max_output_bytes` 截断封顶，无磁盘写爆风险（CC 的看门狗正是为文件模式防磁盘爆而设，pipe 模式不需要）。
- **建议**：file-mode 输出 + 配套看门狗作为独立后续 PR（届时一并改 `get_command_output`），不在本期。本期 Phase 2 只做 7.6 的 (a)(b)(c)(d)。
- 如你坚持本期做 file-mode，我会先改 `get_command_output.rs` 再动 `run_command.rs`，并补跨工具回归测试——但工作量与风险显著上升。

---

## 9. 落地顺序（建议）
1. config.rs 加 `shell_type` + 解析。
2. 新 `shell.rs` 模块（枚举/探测/路径转换/build_invocation）。
3. run_command.rs：`spawn_shell`/`run_foreground` 接入 Invocation + cwd 回写 + 白名单重校验。
4. registry.rs / http.rs 措辞。
5. Phase 2 的 (a)(b)(c)(d)。
6. 测试（现有保留 + 新增 bash/persistence）。
7. `cargo fmt` + `cargo clippy --no-default-features` + `cargo test`（桌面根 `desktop/src-tauri`）。
8. 不自动 commit（规则 5）。
