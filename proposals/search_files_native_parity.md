# search_files 追平 native Claude Code 方案（P6-2 / P6-3）

> 前置已完成：**P6-1** `search_files` 并行遍历 + 强制排除 `target/node_modules/.git`（`build_parallel()`，已合并、8 单测全绿）。
> 本方案回答一个问题：**不考虑网络延迟，cc-bridge 的内容搜索能否做到和本地 Claude Code 一样快、一样准。**
> 结论：**能，且差距比预期小——目标是「效果一致 + 速度达到 native 的 70–90%」。** 剩余 10–30% 是固定开销，可忽略。

---

## 1. 现状剖析：我们和 native CC 差在哪

native Claude Code 自己不写遍历代码，它把「找文件」交给两件事：**Grep**（按内容搜）/ **Glob**（按文件名找），两者底层都是 **ripgrep**——一个 Rust 写的、多线程、SIMD、遵守 `.gitignore` 的搜索引擎。因为它跑在本机、直调 OS API，**没有网络环节**，几万文件也是秒级。

cc-bridge 的 `search_files` 实现位置：`desktop/src-tauri/src/mcp/tools/search_files.rs`。

| 维度 | native Claude Code（ripgrep） | cc-bridge `search_files`（P6-1 后） | 差距 |
|------|-------------------------------|--------------------------------------|------|
| 遍历库 | `ignore` crate（BurntSushi） | **同一个 `ignore` crate**（`Cargo.toml` 第41行 `ignore = "0.4"`） | **已同源** |
| 并行遍历 | 是（多线程 + SIMD） | 是（`build_parallel()`，第188行） | **已对等** |
| 强制排除构建目录 | `.gitignore` 自动挡 | 强制排除 `target/node_modules/.git`（第172行） | **已对等** |
| VCS 目录自动跳 | 默认排除 `.git/.svn/.hg/.bzr/.jj/.sl` | **仅排除 `.git`**（`.svn/.hg` 未排除） | **有差距** |
| 内容搜索引擎 | `grep-searcher`（memmap + SIMD + 字面量预筛） | `BufReader.lines()` 逐行 + `regex` 逐行匹配（第242/270行） | **有差距（核心）** |
| 二进制文件 | `grep-searcher` 自动检测跳过 | 逐行读，二进制内字符串也可能误命中 | **有差距** |
| 非 UTF-8 鲁棒 | `bstr` 处理，GBK 等也能扫 | `.lines()` 遇非法字节 `Err` → **中断该文件漏命中** | **有差距（隐藏 bug）** |
| 结果排序 | Glob 按 mtime 倒序（最近改的优先） | 按路径确定性排序 | **有差距** |

**关键洞察**：遍历已经追平（同源同库 + 已并行）。唯一实打实的速度差在**内容搜索引擎**——我们现在是「朴素逐行正则」，ripgrep 是「内存映射 + SIMD + 字面量先筛」。在大文件上这套能快 2–5 倍。

---

## 2. 差距分层（按「能否追平」分三档）

```
┌─────────────────────────────────────────────────────────────┐
│ 第①档：已追平，不用动                                        │
│   · 遍历（ignore crate 同源）   · 并行遍历（P6-1 已上）        │
│   · 强制排除构建目录（P6-1 已上）                              │
├─────────────────────────────────────────────────────────────┤
│ 第②档：补齐级，几行代码 / 换库——无架构障碍                   │
│   · VCS 目录排除补 .svn/.hg/.bzr  → 几行                     │
│   · 结果按 mtime 倒序排序        → 几行                       │
│   · 非 UTF-8 鲁棒（消除漏搜）    → 随引擎升级一并解决         │
│   · 内容搜索速度（2–5x）         → 引入 grep-searcher 换库    │
├─────────────────────────────────────────────────────────────┤
│ 第③档：诚实边界，追不平但可忽略                              │
│   · 多一层 spawn_blocking + 结果 JSON 序列化（毫秒级固定开销） │
│   · 网络往返（本任务明确「不考虑」，见 §5）                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 落地路线（按性价比排序）

### P6-2. 补齐 VCS 目录排除 + 结果按 mtime 倒序（零风险、立竿见影）

**改动点**：`search_files.rs` 第172行强制排除数组。

```rust
// 现状
for pat in ["!.git", "!target", "!node_modules"] { ... }

// 改为：补充常见 VCS 目录（对齐 ripgrep 默认行为）
for pat in ["!.git", "!.svn", "!.hg", "!.bzr", "!target", "!node_modules"] { ... }
```

- **收益**：用户实测目录 `C:\work\aier\newar`（SVN 工程）含 **7,412 个 `.svn-base` 文件**，当前会被整盘扫进去；补 `.svn` 后即可跳过，遍历与内容搜索都直接少一大截。
- **结果排序**：收集完成后按 `fs::metadata().modified()` 倒序排（`head_limit` 截断前），对齐 native Glob「最近修改优先」的相关性。
- **风险**：极低。强制排除名单只增不减，不影响既有匹配语义。`.svn/.hg` 是版本控制元数据，本就不该进搜索结果。
- **验证**：新增单测 `force_excludes_vcs_dirs_without_gitignore`（仿 P6-1 既有测试）；`cargo test --lib` / `clippy` / `fmt` 全绿。

### P6-3. 内容搜索换用 `grep-searcher` 引擎（一步拿下速度 + 二进制 + 编码鲁棒）

**改动点**：`search_files.rs` 第235–294行（`FilesWithMatches` / `Count` / `Content` 三种模式的内容扫描段）。

**现状**（朴素逐行，存在隐藏 bug）：
```rust
// 第242行（FilesWithMatches）
for line in BufReader::new(file).lines() {        // 遇非法 UTF-8 → Err → break，文件中断
    let Ok(line) = line else { break };
    if content_re.is_match(&line) { found = true; break; }
}
// 第296行（Content）
let Ok(content) = std::fs::read_to_string(path) else { return ... };  // 非法 UTF-8 → 整文件跳过
```

**目标**：引入 ripgrep 同款 `grep-searcher`（`grep-searcher` + `grep-regex`，复用项目已有 `regex`），替换上面整段：
- **内存映射（memmap）**：不在用户态逐行 `read`，大文件扫描快 2–5x。
- **SIMD 行扫描 + 字面量预筛**：`memchr` 先秒定位候选行再上正则，长文件收益显著。
- **二进制检测**：自动跳过二进制文件或标记，不再把 `.class` 等二进制内的字节当文本误匹配。
- **编码鲁棒**：用 `bstr` 处理，GBK 等非 UTF-8 文件不中断、不漏命中（**顺手消除上面的隐藏 bug**）。

**依赖评估（重要，见 §4 风险）**：新增 `grep-searcher`、`grep-regex` 两个 crate。CLAUDE.md 规则8 强调安装包 3.4MB / exe 14MB 是核心卖点，需确认增量可控。`grep-searcher` 本身依赖 `bstr`/`memchr`（多数已通过 `regex`/`ignore` 间接存在），净增有限；**不引入 `grep-cli`**（它大而带额外依赖）。

**风险**：
- 二进制检测默认开启，会改变「能搜到 `.class`/`.png` 内嵌字符串」的现状——需确认是否要保持「可搜二进制」语义；如需保留，可关 `BinaryDetection::none()`。
- 引擎替换是 P6-3 最大的一块改动，需配套重写 P6-1 既有的 `files_with_matches`/`count` 惰性测试，并新增「大文件 / 二进制 / GBK」三类回归测试。

- **验证**：受控基准 `bench_walk_real_project_timing`（`#[ignore]`，P6-1 已加）扩展为「P6-3 引擎 vs P6-1 朴素」A/B 对照；真实大目录（含 `desktop/target` 数千大文件）实测提速倍数应有显著体现（小文件场景并行优势不显，见历史记录）。

---

## 4. 风险与依赖清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| P6-3 新增 `grep-searcher`/`grep-regex` 增大二进制 | 可能冲击 exe 14MB / 安装包 3.4MB 卖点（规则8） | 仅引 `grep-searcher`+`grep-regex`，**不引 `grep-cli`**；`cargo build` 后比对体积 |
| 二进制检测默认跳过 `.class` 等 | 改变「可搜二进制内字符串」现状 | 默认 `BinaryDetection::none()` 保持现有语义，或明确改为跳过后在文档/CHANGELOG 声明 |
| P6-3 引擎替换影响 P6-1 既有测试 | 测试需同步改写 | `files_with_matches`/`count` 惰性测试 + 大文件/二进制/GBK 三类回归 |

---

## 5. 边界与前提

- **本任务明确「不考虑网络延迟」**：目标限定为「本地 I/O + 引擎」层面追平。网络往返（如 `C:\work\aier\newar` 实测遍历 23s 中很大一部分来自映射盘 stat 往返）由 O 组计划的 **O1-b 网络 RTT 探针** 单独量化，不在本方案范围。
- **现实目标 = native 的 70–90% 速度 + 效果一致**。剩 10–30% 来自 `spawn_blocking` 派发 + 结果 JSON 序列化，毫秒级、几万文件搜索里可忽略。
- **对所有「引擎级」改动，先出方案、等用户确认再动代码**（CLAUDE.md 规则1）；改动后递增两处版本号（规则2）、跑 `cargo fmt`+`clippy`（规则7）、等用户说「提交」再 commit（规则5）。

---

## 6. 建议执行顺序

1. **先做 P6-2**（几行、零风险、对 SVN/Hg 工程立刻见效）→ 用户验证 → 提交。
2. **再做 P6-3**（引擎升级，最大收益，含隐藏 bug 修复）→ 受控基准 + 回归测试 → 用户验证 → 提交。
3. 配套：在 `C:\work\aier\newar` 这类老工程放一个 `.gitignore`（`*.class`、`.nc-compile/`）——本地 CC 与 cc-bridge 都能立刻少扫一大截（用户侧操作，非代码改动）。
