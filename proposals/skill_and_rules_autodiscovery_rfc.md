# RFC：项目规则自动加载 + 远程技能清单感知（Skill Autodiscovery）

> 状态：**Part A 已实施（2026-07-17）；Part B 未实施（待 §5 决策）**
> 关联：`mcp/tools/list_allowed_roots.rs`（已实现 CLAUDE.md 内嵌一半功能）、`mcp/http.rs` 的 `initialize` 静态 instructions 文案
> 起因：2026-07-17 会话探索"本地 Claude Code 技能迁移到远程 Linux 环境"+"用 cc-bridge 会不会自动读项目规则"

---

## 1. 背景（已用真实源码核实，非猜测）

**问题 2（项目规则自动加载）其实已经实现了大半：**

- `list_allowed_roots.rs` 已经会遍历 `config.allowed_roots`，探测每个根目录顶层的 `CLAUDE.md`：存在且 ≤20KB 就全文内嵌到响应的 `projectInstructions` 字段；超限则给出路径指针提示改用 `read_files`。
- 该工具的 schema 描述（`registry.rs`）已明确写着："Call this FIRST to discover accessible directories and pick up project rules before attempting any file operation."

**但这件事目前不会真的"自动"发生**，因为：

- MCP `initialize` 握手返回的 `instructions` 字段（`http.rs` 的 `mcp_handler`，`"initialize"` 分支）**已确认会在每次连接时自动注入到调用方上下文**（本次会话开头出现的"MCP Server Instructions"区块正是它）。
- 但这段静态文案里，对 `list_allowed_roots` 的介绍只写了"查询本地允许访问的根目录范围(返回中同时带 allowedExtensions 扩展名白名单)"——**完全没提"顺带拿到项目规则"这件事**，也没有"连接后第一步应调用它"的约定。
- 结果：真正生效与否，取决于调用方（远程 Claude Code）是否**恰好自己想到**去调用这个工具。本次会话就是反例——我全程没有主动调用它，而是手动 `read_files` 了一次 `CLAUDE.md`。

**问题 1（技能迁移）目前完全没有对应机制**：cc-bridge 没有任何扫描/暴露远程项目 `.claude/skills/`、`.claude/commands/`、`.claude/agents/` 的能力。

---

## 2. 目标

- **Part A**：让"连接后自动知道项目规则"这件事真正稳定发生，不再依赖调用方"恰好想到"。
- **Part B**：让"连接后自动知道远程项目有哪些技能/命令/子代理可用"这件事也同样稳定发生，为后续按需同步到本地打基础。

## 3. 非目标

- 不做"cc-bridge 服务端主动把文件推送到 Linux 本地文件系统"——**架构上做不到**：cc-bridge 只运行在 Windows 侧，够不到 Linux 侧的文件系统。真正把技能"装"到 Linux 本地，必然是远程 Claude Code（也就是我）在感知到清单后，用 `read_files`（读 Windows 侧）+ 本地 `Write` 工具（写 Linux 侧）两步完成，cc-bridge 只负责让"清单"自动可见。

---

## 4. 设计方案

### Part A：修复静态 instructions 文案（低风险，纯文案）—— **已实施**

> `http.rs` 的 `initialize` 分支已改：(1) 开头新增"建议连接后第一步调用 list_allowed_roots"的提示；(2) `list_allowed_roots` 的工具介绍补上"若存在 CLAUDE.md 会内嵌到 projectInstructions"。`cargo check`/`clippy -D warnings`/`cargo test --lib mcp::http::` 均通过。全量 `cargo test --lib -- --include-ignored` 时发现一个与本次改动无关的预存失败（`all_tools_dispatch_and_apply_side_effects`，默认 `#[ignore]`）。单独排查后确认是**测试自身的 bug**，不是产品回归：该断言在 `inner_text()`（已把 `result.content[0].text` 解析成真实结果数组）之后多索引了一次不存在的 `["content"]`，对数组用字符串 key 索引会静默返回 null，让后续 `as_array()/and_then` 链恰恰全部跑空，`unwrap_or(true)` 总是命中，导致这条断言无论 `write_files` 实际返回什么都不会失败。已删除多余的 `["content"]` 索引，修复后 `cargo test --lib -- --include-ignored` 全部 105 个测试通过。

只改 `http.rs` `initialize` 分支里那段静态字符串，把 `list_allowed_roots` 的描述从"查询白名单"扩展为：

> "**连接后建议第一步调用 list_allowed_roots**：除返回访问白名单外，还会自动内嵌每个允许根目录顶层 CLAUDE.md 的完整内容（`projectInstructions` 字段），据此了解项目规则，无需再手动 `read_files` 一次。"

- **风险：接近零**——只改一段说明文字，不触碰任何逻辑、安全闸门、协议行为。
- **效果**：以后每次连接 cc-bridge，远程 Claude Code（我）会被明确告知"第一步该干什么"，从而稳定地自动拿到项目规则，不再依赖"记不记得"。

### Part B：技能/命令/子代理清单感知（新能力）

1. 扩展 `list_allowed_roots.rs`：复用现有"探测+读取"逻辑（`tokio::fs` 异步 I/O），额外遍历每个 `allowed_root` 下的：
   - `.claude/skills/*/SKILL.md`
   - `.claude/commands/*.md`
   - `.claude/agents/*.md`
   
   对每个命中的文件，手写解析简单的 `---\nkey: value\n---` frontmatter（不引入 `serde_yaml` 等重依赖，项目里目前也没有 YAML 解析 crate，符合 CLAUDE.md 规则 8「二进制体积红线」的一贯做法），提取 `name`/`description`，汇总成新字段：

   ```json
   "projectSkills": [
     { "type": "skill", "name": "xxx", "description": "...", "path": "C:\\...\\SKILL.md" }
   ],
   "projectCommands": [ ... ],
   "projectAgents": [ ... ]
   ```

2. 更新静态 instructions 文案，补一句类似：

   > "若 `list_allowed_roots` 返回的 `projectSkills`/`projectCommands`/`projectAgents` 非空，且本地（Linux 侧 `~/.claude/skills/` 等）尚未安装同名项，可用 `read_files` 读取对应文件内容，再用本地 `Write` 工具写入对应本地路径完成同步；本地已存在同名项时默认不覆盖。"

---

## 5. 需要你决策的点

1. **同步范围**：只做 `.claude/skills/`，还是 `commands`/`agents` 一起纳入？（成本增量很小，只是多扫两个目录）
2. **本地落地位置**：固定同步到 `~/.claude/skills/`（用户级、全局生效、跨项目可用），还是需要支持"项目专属"落地（若是后者，需要你明确"项目"具体对应 Linux 侧哪个目录，因为当前会话默认工作目录 `/home/lizuliang` 不是任何特定项目的 clone）？
3. **覆盖策略**：本地已有同名技能时——跳过不覆盖（推荐，最安全）/每次都问你/直接覆盖？
4. **自动化程度**：目前设计是"我会自动感知到有哪些技能可拿，但仍由我判断是否要读取+落地"，而不是 cc-bridge 服务端悠悠把文件写进 Linux 本地（架构上也做不到，见 §3 非目标）。这个"感知自动、落地仍是我的一次显式操作"的流程你认可吗？

---

## 6. 工作量与风险估计

| 部分 | 工作量 | 风险 |
|------|--------|------|
| Part A（文案修复） | ~10 分钟 | 接近零，纯文案 |
| Part B（清单扫描 + frontmatter 解析 + 文案更新） | 1-2 小时量级 Rust 改动 + 测试 | 低——纯只读扫描，不涉及任何安全闸门变化，不新增依赖 |

两部分均不改变任何安全模型（Bearer/限流/审计/只读拦截/路径白名单全部不动），仅新增"探测+汇报"逻辑。
