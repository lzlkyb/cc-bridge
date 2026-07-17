# MCP 工具 UX 三处增强 · 实施 RFC

> 状态：✅ 已实现（2026-07-17，未提交；待用户确认后 `feat:` commit）
> 关联：从 `claude-code-main`（CCB）/ 上游 Claude Code 借鉴的工具级 UX 增强，补 cc-bridge 现有 MCP 工具的「防坑 / 可观测性」短板
> 约束：CLAUDE.md 规则 7（安全模块不得放松、守二进制体积、Rust 提交前 `cargo fmt` + `cargo clippy --no-default-features`、公共函数入 `lib/`）
> 借鉴来源：CCB `services/notifier.ts`、`docs/safety/permission-model.mdx`、上游 CC 的 Edit 空白告警与 `isBinaryContent`；CCB Grep 的 `truncated`/`pagination` 回显

---

## 0. 一句话结论

三个**纯增强、零破坏性、零新依赖**的改动，都不动匹配/搜索核心逻辑，向后兼容：

| # | 点 | 插入点（已读真实代码） | 成本 | 收益 |
|---|---|---|---|---|
| ① | Edit `old_string` 空白字符告警 | `edit_files.rs:63` 校验后 | 极低（~15 行） | 高：省掉「多带空白→匹配失败→重试」的远程往返 |
| ③ | `read_files` 显式二进制守卫 | `read_files.rs:114` 读 `raw` 后 | 低-中 | 中高：堵「ASCII+NUL」二进制裸返乱码的洞 |
| ④ | `search_files` 截断回显 | `search_files.rs` 早停处 + `handle` 返回 | 低-中 | 中低：早停时告诉模型「还有更多」 |

实施顺序：**① → ③ → ④**（按性价比）。合一个 `feat:` commit。

---

## 1. 现状与缺口（已读真实代码确认）

- **`edit_files.rs`**：已有 `exact-once` + `replaceAll` + `diff` + 备份 + 原子写（`edit_single` 第 58-155 行）。但 `old_string` 首尾带空格/换行时**不做任何提示**，模型常因此匹配失败重试。
- **`read_files.rs`**：全读路径（第 112-124 行）读 `raw` 后直接 `encoding::read_text` 返回 `content`。二进制只靠 `read_text` 的**有损解码拦截**（`encoding.rs:80`）——这只拦「UTF-8 / GBK / GB18030 全都无法解码」的文件（如含孤立 `0xFF` 字节）。**但大多数二进制会被 GBK/GB18030 误判为可解码而放过**：PNG 头（`0x89`）、EXE 头（`MZ`+NUL）、以及「全 ASCII + NUL」类（`.pyc` / 部分 `.class`）都能被当成文本成功解码，裸返回乱码污染远程 CC 上下文。（已用等价脚本验证：PNG / EXE / ASCII+NUL 当前均「不拦→裸返乱码」，`is_binary_content` 对三者均判 `true` 补洞；合法 UTF-8 / UTF-16 / GBK 中文均判 `false` 不误伤。）
- **`search_files.rs`**：已有 `head_limit`/`max_results` 早停（第 240/275/307/315 行的 `WalkState::Quit`），但早停时**不告知模型**「结果被截断」，模型可能误以为搜全了。

---

## 2. ① Edit 空白字符告警

**设计**：在 `old_string` 校验通过后、读文件前，检测首尾空白并生成 `warning`；`warning` 经 `EditOutcome` 传回 `handle`，仅在 `Some` 时追加到返回 JSON。**只告警、不改匹配逻辑**。

### 改动 1 · `edit_files.rs` 新增私有函数

```rust
/// 检测 old_string 首尾是否含多余空白，返回人类可读告警。
/// 仅用于提示模型，不影响匹配（old_string 仍按原样匹配）。
fn whitespace_warning(s: &str) -> Option<String> {
    let lead = s.len() - s.trim_start().len();
    let trail = s.len() - s.trim_end().len();
    if lead == 0 && trail == 0 {
        return None;
    }
    let leading_space = s.chars().take(lead).filter(|c| *c == ' ').count();
    let leading_tab = s.chars().take(lead).filter(|c| *c == '\t').count();
    let trailing_space = s.chars().rev().take(trail).filter(|c| *c == ' ').count();
    let trailing_tab = s.chars().rev().take(trail).filter(|c| *c == '\t').count();
    let nl = s.matches('\n').count();
    let cr = s.matches('\r').count();
    Some(format!(
        "oldString 首尾含空白：前导 {lead} 字符（空格 {leading_space}/制表符 {leading_tab}）、尾随 {trail} 字符（空格 {trailing_space}/制表符 {trailing_tab}），且含换行 {nl} 个、回车 {cr} 个。若非预期请去掉首尾空白再重试，避免匹配错位。"
    ))
}
```

### 改动 2 · `edit_single` 计算 warning

在第 68 行（`old_string == new_string` 校验）之后插入：

```rust
let warning = whitespace_warning(&f.old_string);
```

### 改动 3 · `EditOutcome` 增加字段 + `handle` 返回携带

```rust
struct EditOutcome {
    replacements: usize,
    encoding: String,
    newline: &'static str,
    diff: String,
    warning: Option<String>,   // 新增
}
```

`handle` 第 34-41 行的 `json!` 增加一行（仅在 `Some` 时输出，保持旧结果干净）：

```rust
"diff": outcome.diff,
"warning": outcome.warning,   // serde 对 Option 默认：None 序列为 null；如想完全省略可加 #[serde(skip_serializing_if="Option::is_none")]
```

### 测试（新增 `edit_files.rs` `#[cfg(test)]`）

- `old_string = "  fn main()\n"`（前导 2 空格 + 尾换行）→ 断言 `warning` 含「前导」「尾随」「换行」。
- `old_string = "fn main()"` → 断言 `warning` 为 `None`。
- 回归：warning 存在时匹配逻辑不变（仍按原 `old_string` 匹配）。

---

## 3. ③ `read_files` 显式二进制守卫

**设计**：新增 `encoding::is_binary_content(data: &[u8]) -> bool`，在 `read_files` 全读路径 `raw` 读取后、`encoding::read_text` 前调用，命中即返回友好提示而非乱码。与 `read_text` 的有损拦截**互补**（后者兜底，前者更前置、更友好、且覆盖「ASCII+NUL」漏洞）。

### 改动 1 · `encoding.rs` 新增 `is_binary_content`

```rust
/// 判断字节流是否为二进制（避免 read_files 向远程返回乱码）。
/// 安全前提：合法文本几乎不含孤立 NUL；即便误拦也只是返回「二进制」提示而非乱码，
/// 比返回乱码更安全。UTF-16/UTF-32 的 BOM 合法，必须排除，否则会误杀中文 UTF-16 文件。
pub fn is_binary_content(data: &[u8]) -> bool {
    // 排除合法 UTF-16/UTF-32 BOM（非二进制）
    if data.starts_with(&[0xFF, 0xFE])
        || data.starts_with(&[0xFE, 0xFF])
        || data.starts_with(&[0xFF, 0xFE, 0x00])
        || data.starts_with(&[0x00, 0xFE, 0xFF])
    {
        return false;
    }
    // 采样：大文件只看前 8KB，足够识别二进制头。
    let sample_len = data.len().min(8192);
    let sample = &data[..sample_len];
    // 规则 1：含任意 NUL 字节即判二进制（纯文本含孤立 NUL 极罕见）。
    if sample.contains(&0x00) {
        return true;
    }
    // 规则 2：非打印控制字符（除 \t \n \r \x0C \x0B）占比超阈值即判二进制。
    let non_print = sample
        .iter()
        .filter(|&&b| {
            b < 0x09 || (b > 0x0D && b < 0x20) || b == 0x7F
        })
        .count();
    non_print as f32 / sample_len as f32 > 0.10
}
```

### 改动 2 · `read_files.rs` 全读路径插入守卫

第 114 行 `let raw = tokio::fs::read(&resolved).await?;` 之后、`encoding::read_text` 之前：

```rust
if encoding::is_binary_content(&raw) {
    return Ok(json!({
        "path": file_path,
        "binary": true,
        "note": "binary file detected, content not returned (not shown to avoid garbage output polluting context)"
    }));
}
```

### 改动 3 · 流式路径（`read_range_streaming`）可选守卫

流式路径仅在「指定 `startLine`/`endLine` 且编码可确定」时走，通常是已知文本，二进制概率低。为稳健可先 peek 前 8KB：打开文件后先 `read_exact`/读前 8KB 判断，命中即返回上面的 `binary` 提示，否则继续逐行流式。若评估成本，可本期**仅做全读路径守卫**（覆盖 `read_files` 无行范围的大头场景），流式路径留 TODO。

### 测试（放 `encoding.rs` 现有 `#[cfg(test)]`，复用 `encode_string`）

- PNG 头 `[0x89,0x50,0x4E,0x47,...]` → `is_binary_content` `true`（**当前 `read_text` 会把 PNG/EXE 经 GBK/GB18030 误解码返回乱码而非拦截**，守卫正补此漏洞，并非双保险）。
- 全 ASCII+NUL `[0x00,b'w',b'o',b'r',b'l',b'd']` → `true`（**当前 `read_text` 会返回 Ok 乱码，此守卫拦住**）。
- 合法 UTF-16LE `"hi"` 带 BOM `[0xFF,0xFE,0x68,0x00,0x69,0x00]` → `false`（排除 UTF-16 BOM，不当二进制）。
- 普通 UTF-8 文本 → `false`。

---

## 4. ④ `search_files` 截断回显

**设计（非破坏性）**：截断信息作为**第二个 `text` content block** 追加到返回，不动 `matches` 数组结构——远程 CC 模型读自然语言提示即可理解「还有更多」，MCP 协议允许多 text block。

> 不选「精确 `totalMatched`」：并行早停拿不到精确总数，精确化需二次全量扫描（开销高、违背性能卖点）。给 `truncated` 布尔 + 返回条数已足够模型决策。

### 改动 1 · `walk_search_blocking_tracked` 返回 `(Vec<Value>, bool)`

在闭包内新增 `let truncated = Arc::new(AtomicBool::new(false));`，在三处 `WalkState::Quit` 前 `truncated.store(true, Ordering::Relaxed);`。函数尾返回 `(out, truncated.load(Ordering::Relaxed))`。

### 改动 2 · 测试包装 `walk_search_blocking` 保持 `Vec<Value>`（测试零改动）

```rust
pub fn walk_search_blocking(...) -> Vec<Value> {
    walk_search_blocking_tracked(...).0   // 丢弃 truncated，现有所有测试调用不受影响
}
```

新增一个 `#[cfg(test)]` 辅助 `walk_search_blocking_truncated(...)` 返回 `(Vec<Value>, bool)`，供截断测试使用。

### 改动 3 · `handle` 构造多 block 返回

第 159-161 行改为：

```rust
let (matches, truncated) = walk_search_blocking_tracked(
    &root_resolved, name_matcher.as_ref(), content_regex.as_ref(),
    &grep, max_file_size, Some(&io_tracker),
);
let mut content = vec![json!({
    "type": "text",
    "text": serde_json::to_string_pretty(&matches).unwrap(),
})];
if truncated {
    let limit = args.head_limit.unwrap_or(args.max_results);
    content.push(json!({
        "type": "text",
        "text": format!(
            "搜索结果已被 maxResults/headLimit（={limit}）截断，本次返回 {} 条。如需完整结果，请缩小搜索范围、指定 rootPath 子目录，或提高 maxResults/headLimit。",
            matches.len()
        ),
    }));
}
Ok(json!({ "content": content }))
```

### 测试（放 `search_files.rs` 现有 `#[cfg(test)]`）

- 构造超过 `head_limit` 的 fixture（如 50 个匹配），用 `walk_search_blocking_truncated` 断言 `truncated == true` 且 `matches.len() <= limit`。
- 精确搜索（结果数 < limit）断言 `truncated == false`。

---

## 5. 向后兼容 & 风险

- **①③④ 全为增量**：① 加可选 `warning` 字段；③ 命中二进制返回新结构（旧路径文本文件不受影响）；④ 追加第二个 content block。均不删不改现有 JSON 字段。
- **③ 误拦风险**：`is_binary_content` 把「含孤立 NUL」判二进制。合法纯文本含孤立 NUL 极罕见；即便误拦也只是返回「二进制」提示而非乱码，比返回乱码安全。UTF-16 BOM 已显式排除。
- **④ 第二个 block**：MCP 协议允许多 `text` block，非破坏性；远程 CC 模型能自然理解。

---

## 6. 实施步骤 & 质量门

1. 实施 ①（`edit_files.rs`：`whitespace_warning` + `EditOutcome.warning` + 测试）。
2. 实施 ③（`encoding.rs`：`is_binary_content` + 测试；`read_files.rs`：全读路径守卫；流式路径按需）。
3. 实施 ④（`search_files.rs`：`walk_search_blocking_tracked` 返回 tuple + `handle` 多 block + 测试）。
4. 每步后：`cargo fmt` + `cargo clippy --no-default-features`（规则 7 强制）+ 跑 `cargo test`。
5. 合一个 commit：`feat: MCP 工具 UX 增强：Edit 空白告警 / read_files 二进制守卫 / search_files 截断提示`（遵循 CLAUDE.md commit 前缀规范）。

---

## 7. 不在此次范围

**② Read 行号前缀 + 续读提示**：需配套改工具 `description` 写明「行号不是内容的一部分」，否则模型会把 `12\t` 编进 `old_string` 导致 Edit 失败（CC 真实踩坑）；且收益被 `search_files` 已有行号输出部分覆盖。单独排期，不与 ①③④ 混做。

---

## 8. 实施记录（2026-07-17，已实现未提交）

代码已落地，通过 `cargo fmt` + `cargo clippy --no-default-features`（零警告）+ `cargo test`（93 单测 + 4 集成，0 失败）。相对 RFC 原文有 3 处实现细化：

1. **① `EditError` 额外实现 `From<&str>`**：`edit_single` 中有一处 `"path is a directory".into()` 直接对 `&str` 调 `.into()`，仅 `From<String>` 会编译失败，故补 `From<&str>`（`warning` 默认 `None`）。其余 early-return 显式携带 `warning`（`From<String>` 的 `?` 传播路径 `warning` 为 `None`，符合预期）。

2. **③ 二进制命中返回 `Err` 而非 `Ok({binary:true})`，且流式路径也加了守卫**：
   - RFC 原文写「返回 `Ok({binary:true, note})`」。实际改为 `return Err("文件疑似二进制内容…")`——对齐上游 CC「二进制读取即错误」语义，远程 CC 代理能明确感知读取未产生内容，比静默 `ok:true` 更清晰。
   - RFC 把流式路径（`read_range_streaming`）标为「可选」。实际也加了守卫：打开文件后先 peek 前 8KB 调 `is_binary_content`，命中即返回同样提示并 `seek` 回文件头（仅多读 8KB，开销可忽略），避免「流式读二进制裸返乱码」的半截实现。

3. **④ 截断判定用 walker 精确 `truncated` 布尔，弃用 `matches.len() >= limit` 启发式**：
   - RFC 原设想在 `handle` 用 `matches.len() >= effective_limit` 反推截断。实测暴露并行 walker 的 `head_limit` 是**软上限**：20 文件 / limit=5 的用例下，name 模式结果数**冲到 9**（并行线程竞态越过上限），content 模式结果数**掉到 3**（早停在 limit 之下）。启发式会同时「误报」(9≥5) 与「漏报」(3<5)。
   - 改为 `walk_search_blocking_tracked` 返回 `(Vec<Value>, bool)`，`bool` 在任意 `WalkState::Quit`（因 limit）处置 `true`，确定性且零歧义。测试包装 `walk_search_blocking` 仍返回 `Vec<Value>`（丢弃 bool），**全部既有测试调用零改动**；新增 3 个测试覆盖「content 截断 / name 截断 / 限量内不截断」。

