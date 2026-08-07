# 通用 MCP 桥 · 第一步实施方案

> 日期：2026-08-07
> 前身：`docs/cc-bridge-mcp-bridge-plan.md`（外部会话产出的总体构想）已评审，本文是可执行版。
> 实测依据：`D:\AItool\aiwork\mcp-probe\probe.rs`（零依赖探针，2026-08-07 在本机跑过）

## 目标

**用户本机已有的任意 MCP server，都能通过 cc-bridge 给远程 Claude Code 用。**

边界：
- ✅ **协议级通用**——任何 stdio MCP server，不限语言与安装方式
- ✅ **零代码新增**——用户加一个 server 只改配置，cc-bridge 不用改一行
- ❌ 不为任何具体 server 写适配层（那是反模式）
- ❌ 第一步不支持 HTTP/SSE 型的 MCP server（配置结构预留字段，见 §10）

---

## 0. 一句话

先只加**两个内置工具**（`mcp_list_servers` / `mcp_proxy`）把外挂 stdio MCP server 代理出去，
**不动 `ToolSpec`、不动只读门、不引 rmcp**。

两个关键设计：
1. **工具清单（manifest）在配置时抓一次并持久化**，运行时的发现不启动任何子进程。
2. **从用户已有的 MCP 客户端配置里导入**，而不是让他重新手输。

单工具代理是**起步形态，不是终态**；扁平化成 `mcp__x__y` 是已规划的终点（§3 / §16）。

---

## 1. 实测确认的事实（不是估计）

### 1.1 协议与进程（探针结果）

| 编号 | 结论 | 证据 |
|---|---|---|
| F1 | `Command::new("codegraph")` 在 Windows 上直接失败 | 报 `program not found`。Rust 的 `Command` 不查 PATHEXT，而 npm 装出来的入口是 `codegraph.cmd` |
| F2 | 走 `cmd /C` 可以 spawn | 探针 T2 |
| F3 | **stdout 是干净的 NDJSON，零污染**；stderr 一行都没有 | 探针 T3。这是最大的不确定性，结果最好 |
| F4 | `initialize` → `notifications/initialized` → `tools/list` 全通 | 探针 T4。`protocolVersion` 发 `2024-11-05` 被原样回；8 个工具 |
| F5 | **杀直接子进程会留下两个孤儿 node；而关 stdin 它们会自己干净退出** | 探针 hold 模式。进程树实际四层：`cc-bridge → cmd.exe → node.exe → node.exe` |

> F5 修正了一个早先的判断。第一次测没测出孤儿，是因为探针 kill 完自己也退了、管道句柄全关，
> node 读到 EOF 自己走了——那个测法分不清是谁让它退的。押着 stdin 句柄不放再测，孤儿就出来了。

### 1.2 本机已有的 MCP server（从 `~/.claude.json` 读出，只取名字与命令，不取 env 值）

| 名字 | command | args | env 键 |
|---|---|---|---|
| `filesystem` | `cmd` | `/c npx -y @modelcontextprotocol/server-filesystem D:` | 无 |
| `codegraph` | `codegraph` | `serve --mcp` | 无 |
| `paper_search_mcp` | `python.exe` | `-m paper_search_mcp.server` | `SEMANTIC_SCHOLAR_API_KEY` |

**三个 server，三种完全不同的形态**——这就是“通用”要面对的真实分布，N>1 是现在就成立的：

- **F6**：真实配置里 `command` 可能就是 `cmd`，用户自己已经包了一层 `cmd /c`。
  桥不能假设 `command` 是“真正的 server 可执行文件”。
- **F7**：命令形态跨 npx / python / 裸名字三种，本机还装了 `uv` / `uvx`（Python 系 MCP 常用）。
- **F8**：env 里真的有 API key。

### 1.3 🔴 F9：现成配置里已经有一个能绕过白名单的 server

`filesystem` 的参数末尾是它的根目录：**`D:`**。

而 cc-bridge 当前在 D 盘只开了三个白名单目录（`D:\AItool\aiwork`、`D:\ncc\1909home`、`D:\ncc\UClient`）。

**把这个 server 桥出去，远程就拿到整个 D 盘的读写能力，白名单完全绕过。**

这不是假想的风险，是这台机器上现在就存在的配置。它直接决定了 §6 里几条安全约束的强度，
也是“本地用”与“桥给远程用”的本质区别：同一份配置，在本机是你自己用，桥出去就是交给远端。

---

## 2. 为何不用 `rmcp`，自己写 client

1. **用 rmcp 就拿不回进程树控制权。** 它的 `TokioChildProcess` 自己管子进程（`kill_on_drop`），
   而 F5 证明那只能杀到第二层。项目现有的 `process-wrap` JobObject / process-group 才能兑现
   “杀整树”，而它得由我们自己持有 `Command` 才能套上去。
2. **依赖代价不可控。** `Cargo.toml` 现在把 `windows` 精确锁在 0.56 以对齐 `process-wrap =8.0.2`，
   里面有两段注释专门讲“避免拉入第二份 windows 0.61 绑定膨胀二进制”。rmcp 3.x 很可能破这个对齐。
3. **要写的东西本来就不多。** 只需四个方法，全是 NDJSON 上的 JSON-RPC 2.0。cc-bridge
   **已经手写了这个协议的服务端**，客户端方向约 250 行。探针用零依赖 + std 就跑通了。

> 反向意见也记一笔：将来若要支持 SSE / 协议协商 / 资源与提示词，rmcp 会真的省事。
> 但那是 `P5-1`（服务端迁 rmcp）要解的题，不应该在这一步搭进来。

---

## 3. 为何第一步只做单工具代理

原方案要把每个外挂工具展开成一个 `ToolSpec`。但现有结构装不下：

```rust
// registry.rs:30-42
pub struct ToolSpec {
    pub name: &'static str,          // ← 不是 String
    pub desc: &'static str,          // ← 不是 String
    pub run: ToolRunner,             // ← fn 指针，不是 Box<dyn Fn>，装不下闭包
}
// http.rs:496
static WRITE_SET: OnceLock<HashSet<&'static str>> = OnceLock::new();  // ← 只算一次
```

扁平化要么改 `ToolSpec`（波及 registry / dispatch_tool / batch / get_tool_definitions 四处），
要么动 `WRITE_SET` 这个**只读模式的安全门**。两件事都不应该在“还没验证链路能不能跑通”时做。

单工具代理则完全贴合现有结构：两个普通内置工具，`name`/`desc` 就是字面量，`run` 就是
`register_tool!` 展开出来的 fn。**registry 一个字段都不用改。**

### 扁平化是终点，不是可选项

当外挂 server 变多，单工具代理会不够用：模型得**先猜哪个 server 有它要的能力**，
而那本来是客户端自己的工具选择机制该干的活。所以扁平化是已规划的终点。

实现路径（不用改 `ToolSpec`）：启动时从**持久化的 manifest** 里把工具名 `Box::leak` 成
`&'static str`，所有外挂工具**共用同一个 fn 指针**，那个 fn 从 `name` 自己解出 server/tool
再查全局单例——`run` 不需要捕获任何东西，函数指针就够用。

> 🔴 **这里有个硬约束，决定了第一步必须把 manifest 落盘**：`all_tools()` 是个
> **不接任何参数**的函数，而 `WRITE_SET` 的 `OnceLock` 在进程内只算一次。
> 要在里面列出外挂工具，就必须有一份**进程启动时就能同步读到、不依赖任何子进程活着**的清单。
> 若第一步不做持久化，第二步就只剩“启动时把所有 server 都拉起来握一遍手”这一条路——
> 那在 N 个 server 下是灾难。

---

## 4. 模块与文件

```
desktop/src-tauri/src/mcp/bridge/
  mod.rs        —— McpBridge 单例：连接池 + 生命周期
  client.rs     —— stdio JSON-RPC 客户端（握手 / list / call）
  spawn.rs      —— 跨平台命令解析 + JobObject 包装
  manifest.rs   —— 工具清单的抓取、持久化、刷新
  import.rs     —— 从已有 MCP 客户端配置导入
  config.rs     —— ExternalMcpServer 结构与校验
desktop/src-tauri/src/mcp/tools/
  mcp_list_servers.rs
  mcp_proxy.rs
```

改动点只有三处：`tools/mod.rs` 声明两个新模块、`registry.rs` 加两行 `register_tool!`、
`state.rs` 挂一个 `bridge: Arc<McpBridge>`。**`http.rs` 不动。**

---

## 5. 两个工具的契约

### `mcp_list_servers`（`is_write: false`）

**默认返回紧凑索引**（不带 schema），数据全部来自**持久化的 manifest**，不启动任何进程：

```jsonc
// 无参 → 紧凑索引
{
  "servers": [{
    "name": "codegraph",
    "state": "ready",
    "toolCount": 8,
    "tools": [ { "name": "codegraph_search", "summary": "Quick symbol search by name…" } ]
  }]
}

// { "server": "codegraph" } → 该 server 的完整 schema + instructions
// { "server": "codegraph", "tool": "codegraph_search" } → 单个工具的完整 schema
// { "refresh": true }  → 重新抓取 manifest（会启动子进程，显式请求才做）
```

为何分层：N 个 server × 每个十几个工具的**完整 `inputSchema`** 是很大一坠，
而它是工具**返回值**——客户端不会像 `tools/list` 那样缓存，每次新会话都得重新灼进上下文。
默认不列 `not_installed` 的 server（带 `includeUnavailable: true` 才列），避免噪声。

### `mcp_proxy`（`is_write: true`）

```jsonc
{ "server": "codegraph", "tool": "codegraph_search", "args": { "query": "auth" } }
```

返回外挂 server 的 `CallToolResult.content` 原文。

**为何标 `is_write: true`**：cc-bridge 无法知道外挂工具到底读还是写（参数 schema 是对方定义的）。
只读模式下宁可全部拦住。

> 代价：只读模式下连纯查询类工具也用不了。第二步可加每-server 的 `readonly_safe`
> （默认 false，由**本机管理员**手动勾）来放宽。第一步不做。

**`batch` 白捐一个好处**：`mcp_proxy` 是普通工具，所以现有的 `batch` 能把多个跨 server 的
调用合成一次网络往返——远程链路下这是真实收益，不用额外写代码。

---

## 6. 🔴 安全边界（本文最重要的一节）

原方案写的“外挂视为只读，走 cc-bridge 自己的白名单”是假的。白名单靠 `resolve_safe_path` 对
**已知字段**（path / files / cwd）做 canonicalize + 祖先遍历；外挂 server 的入参结构由它自己定义，
cc-bridge 既不知道哪个字段是路径，也管不着它——**它是独立进程，白名单对它零约束力**。

F9 已经把这件事从“理论风险”变成“这台机器上当下的事实”。所以：

### S0 桥接是能力让渡，必须在 UI 上说清楚

本地用一个 MCP 与把它桥给远程，**不是同一件事**。设置页必须每个 server 单独列出并说明：

> 启用后，远程 Claude Code 将获得该 server 的**全部能力**。
> cc-bridge 的路径白名单**管不着它**——它是独立进程，能碰到什么由它自己的参数决定。

对 `filesystem` 这类已知会吃目录参数的 server，**把它的 args 原样展在开关旁边**，
让用户看得见自己要交出去的是 `D:` 还是某个子目录。不做智能解析（参数含义因 server 而异，
解析就是写适配层，违反通用原则），**但一定要展示**。

### S1 配置只能本机改，**绝不经由 MCP 写入**

外挂 server 列表存在 **SQLite 的 config 表**（不是 `config.json`——那个文件只在启动迁移时读一次
就被重命名成 `.migrated`，见 `db.rs:52-66`），**只能通过 Tauri 命令（前端设置页）修改**。

配置里写的是“要启动哪个可执行文件”，**能改配置 = 能以本机用户身份执行任意程序**。
而 `run_command` 现在有三道闸（`shell_enabled` 默认关 + 危险命令拦截 + 命令白名单），
桥接的 spawn 一道都不走。

- 新增 / 启用 / 修改 command 与 args，**均需前端二次确认**（同「开启命令执行」那级）。
- 任何启用状态变化**写审计日志**。

### S2 导入是“逐个勾选”，不是“全部导入”

导入功能（§9）只负责**把已有配置读出来展示**，默认全部**不启用**，用户逐个勾。
绝不能“扫到就开”——F9 就是反例：扫到的第一个就是个能交出整个 D 盘的。

### S3 不继承 `shell_enabled`，但共享只读模式

- **不**把桥接挂在 `shell_enabled` 下：那个开关的语义是“允许远程跑任意命令”，而桥接是
  “允许远程调用**本机管理员预先指定的**几个程序”。合并会让两个开关都变模糊。
- 单独一个 `external_mcp_enabled` 总开关，**默认关**。
- 只读模式仍能拦住 `mcp_proxy`（靠 `is_write: true`，现有机制自动生效）。

### S4 审计要诚实地记“看不见”

审计只能记下 `mcp_proxy` 转发了什么（server / tool / args 摘要 / 耗时 / 成败），
**对方进程内部读写了哪些文件是黑盒**。这一点要写进工具描述与设置页文案。

### S5 args 透传不做“聊胜于无”的校验

不要写“扫一遍 args 里长得像路径的字段再校白名单”这种启发式——它拦不住真攻击（字段名任意、
可嵌套、可编码），却会让人产生“已经防住了”的错觉。要么不做，要么做真的（沙箱 / 受限令牌）。

### S6 不做“自动安装”按钮

原方案的 D5（点一下 `cargo install --git …`）与产品的信任模型直接冲突，**砍掉**。
只做检测 + 展示安装命令（可复制）。

### S8 🔴 必须排除 cc-bridge 自己

用户的 `~/.claude.json` 里**很可能就配着 cc-bridge**（本来就是用 `claude mcp add` 加进去的）。
把它当成外挂 server 导入，就是**自己桥自己**：

```
远程 Claude Code → cc-bridge → mcp_proxy → cc-bridge → mcp_proxy → …
```

每一跳都占一条连接与一个请求槽，循环调用会直接把自己拖死；而且它没有任何意义——
远程本来就直连着 cc-bridge，内置工具已经在 `tools/list` 里了。

> 项目里已经有同类先例：`batch` 工具明确**拒绝嵌套 batch**（`rejects_nested_batch` 测试守着）。
> 这里是同一个道理的跨进程版本。

**判定依据（不靠名字）**：

1. `command` 解析后的绝对路径 == `std::env::current_exe()`（两边都 canonicalize 再比）
2. `transport` 为 `http`/`sse` 且 URL 的 host:port 命中**本机当前监听的地址**
   （含 `127.0.0.1` / `localhost` / 所有 LAN IP，端口取当前配置）
3. 名字含 `cc-bridge` **只作提示，不作判定**——名字是用户随便取的，既会误判也会漏判。

**两道卡**：导入时直接滤掉（列出但置灰并注明“这就是 cc-bridge 自己”）；
**保存配置时再校一次**并拒绝——用户可能绕过导入手加。

跨机器的另一个 cc-bridge 实例是 `http` 型，第一步本来就不支持；将来支持时这条规则只排除**自身**，
不排除别的机器（那是合法用法，但得另行评估环路风险）。

### S7 密钥只进不出

`env` 里有真实的 API key（F8）。**审计、日志、前端展示、导出配置均只出现键名**，
值走跟 Token 同一套掩码。导入时也一样——预览界面不得回显密钥明文。

---

## 7. 进程生命周期

### 7.1 命令解析（F1 + F6）

不能直接 `Command::new(&spec.command)`：`codegraph` 这种裸名字在 Windows 上找不到（F1）。

做法：**Windows 下自己按 `PATHEXT` 遍历 PATH 解析出真实可执行文件**（`.cmd` / `.exe` / `.bat`），
直接 spawn 它；mac / Linux 直接 spawn。这套对 `npx` / `uvx` / `python.exe` / 裸名字四种形态都成立，
不需要为任何具体 server 特例。

🔴 **但不能重写用户的配置**。F6 显示真实配置里 `command` 就是 `cmd`、args 是 `/c npx …`。
那是用户自己的选择，**原样执行**，不要“智能地”把它拆成 `npx …`——拆就是写适配层，
而且一旦拆错行为就变了。只在**导入预览时提醒**：这个条目经过 `cmd` 解析器，args 里的
`&` `|` 会被当成命令分隔符。

### 7.2 关闭：先关 stdin，JobObject 兜底（F5）

```
1. drop 掉 stdin 句柄                    ← MCP stdio 的约定：server 读到 EOF 就自己退
2. 等最多 3s                              ← 实测 codegraph 在此期间两个 node 都干净退了
3. 还活着 → process-wrap 杀整树       ← 兜底，Windows 走 TerminateJobObject
```

第 3 步必须有：它不是为 codegraph 准备的，是为“将来某个不响应 EOF 的 server”准备的。
直接复用 `run_command.rs` 已有的 `process-wrap` 包装路径，不重写。

### 7.3 启动时机：配置时抓 manifest，运行时懒启动

```
管理员在设置页新增/启用 server（一次性）：
    启动 → 握手 → tools/list → 存入 SQLite → 关掉
运行时 mcp_list_servers：
    直接读库，**零进程启动**，毫秒级
运行时 mcp_proxy：
    这时才懒启动那一个 server（且只启那一个）
```

为何不能“要列工具就先握手”：那在 N 个 server 下是**首次调用就冷启动全部**，
本机已有 3 个（其中两个是 Node、一个是 Python），十几秒起步——而那还只是模型“想看看有什么工具”。

manifest 失效：`command` / `args` 变了就作废；否则靠用户在 UI 上点“刷新”或传 `refresh: true`。
**不做自动定期刷新**（那要新增定时任务，得过 CLAUDE.md §8.1 那张清单）。

> **未做**：空闲自动关停。同样因为要新增定时任务。进程随 cc-bridge 退出而终止。
> 但 N 个 server 常驻的内存开销是真实的（每个都可能带索引/监听），这是**第二步的必做项**。

---

## 8. 协议实现细节

### 8.1 协议版本协商要通用，不能写死

探针里写死 `2024-11-05` 是为了快。通用桥不能这么干：

1. 发我们首选的版本。
2. server 回什么就**用它回的那个**（规范允许 server 选不同版本）。
3. server 报错且错误里给了支持版本 → **用它给的版本重试一次**。
4. 仍失败 → `state: failed` 并把原始错误原文呈给用户（不自作主张翻译）。

同理：握手后要看 `capabilities`。**没有 `tools` 能力的 server 直接标为不可用**，
而不是去调 `tools/list` 然后拿一个不知所云的错误。

### 8.2 并发模型：每个 server 一把锁，串行请求

stdin/stdout 是**单一流**。第一步用 `Mutex<Connection>` 串行请求-响应，不做 id 多路复用。
同一 server 的两个调用排队；**不同 server 互不影响**（所以 N 个 server 并行没问题）。
写进注释：将来挂了带网络 IO 的慢 server，这里要改成多路复用。

### 8.3 超时后**保留**连接（2026-08-07 真机联调后推翻原设计）

> **原文写的是**：单次调用超时后连接状态已不可信，迟到的响应会跟下一次请求对不齐，
> 造成“拿到别人的结果”，所以**超时 → 标记连接为污染 → 关掉重建**。
>
> **实测推翻了它**：codegraph 在一个 1.5GB 索引的项目上前两次调用都超过 60s，
> 而每次超时都重建 → 每次都从冷启动重来 → **永远收敛不了**。它最后能成功纯属侥幸
> ——codegraph 自己有个共享 daemon 在后台把索引预热好了。换一个没有 daemon 的
> server，这个设计会让它**永久不可用**。

现在的做法：**超时只失败这一次，连接留着**，进程与它已加载的东西都不浪费。

这样做是安全的，因为原来担心的对不齐**在这里不可能发生**：

- 请求 id 单调递增（`next_id += 1`）；
- 请求严格串行（所有方法都取 `&mut self`，编译器保证不会交错）。

所以被放弃那条的响应迟到时，它的 id 必定**小于**下一次请求的 id，
会被 `pump` 里那支 `_ => continue` 丢掉。“拿到别人的结果”需要 id 撞车，而这里撞不上。

仍然销毁连接的情形（这些是真没救了）：读线程报错、server 进程退出（stdout 关闭）、写管道失败。

### 8.4 健壮性：不要假设对方很乖

通用桥要面对的是**任意人写的 server**，F3 只能代表 codegraph 0.9.9：

- **stdout 混入非 JSON**：不以 `{` 开头的行跳过并计数，超阈写一条 warn。
- **非 UTF-8 字节**：按**字节**读行后做 `from_utf8_lossy`，**不能让一个乱码字节直接断连**。
  （探针用的 `BufReader::lines()` 遇非 UTF-8 会返回 `Err` 而收工——那在产品里不够。
  中文 Windows 上的 Python/Node server 很可能吐 GBK 日志。）
- **单行上限**：默认 8MB（与 `maxFileSizeBytes` 同量级），超过则**该次调用报错**并断连——
  不静默截断（截断的 JSON 解不开，会变成更难查的错）。

### 8.5 读行循环（对照 CLAUDE.md §8.1 逐条回答）

1. **让出点**：在管道上阻塞读——真阻塞，不是忙等。
2. **生产端异常时**：子进程死 → 管道关 → 读到 EOF → **显式退出线程**并把连接标为死。
3. **“流结束”信号**：EOF 与 读错 各自分支，**禁止 `let _ = …`**。
4. **单次成本**：一次管道读，无轮询、无定时器。
5. **兜底上限**：单行 8MB（见 8.4）。
6. **平台分支**：命令解析在 Windows / Unix 两条路。Unix 那支靠单测（拿 `/bin/echo` 做假 server），
   不靠“看着对”。

---

## 9. 从已有配置导入

用户手上已经有配好的 MCP（本机就有 3 个）。让他到设置页重新手输 command / args / env
是很差的体验，也容易输错。

扫描以下位置（存在才读，读不到静默跳过）：

| 来源 | 路径 | 本机实测 |
|---|---|---|
| Claude Code | `~/.claude.json` 的 `mcpServers`，及 `projects.*.mcpServers` | ✅ 3 个 |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` | 未安装 |
| Cursor | `~/.cursor/mcp.json` | 未安装 |
| 项目级 | 白名单根目录下的 `.mcp.json` | — |

字段几乎 1:1 对应（`command` / `args` / `env` / `type`），映射不需要猜。

导入的硬规矩：
- **默认全部不启用**，逐个勾（S2）。
- 预览里完整展示 `command` + `args`，让用户看得见 `D:` 这种参数（S0）。
- `env` **只列键名**，值掩码（S7）。
- 非 stdio 类型（`type: "http"` / `"sse"`）**列出但置灰**，标“第一步不支持”，不静默丢掉。
- **cc-bridge 自己必须被认出来并排除**（S8）。列出但置灰，注明“这就是 cc-bridge 自己，
  无需也不能桥接”——直接不显示反而会让用户以为扫漏了。
- 导入是**一次性拷贝**，不建立同步关系——否则用户改 `~/.claude.json` 会静默改变远程能力边界，
  这跟 S1 直接矛盾。

---

## 10. 配置模型

```rust
/// 外挂 MCP server 总开关。默认 false——它等于多一条执行通道，必须显式开。
pub external_mcp_enabled: bool,
/// 外挂 server 列表（JSON 数组存一个 config 键里，跟现有 allowed_roots 同套做法）。
pub external_mcp_servers: Vec<ExternalMcpServer>,
```

```rust
pub struct ExternalMcpServer {
    pub name: String,                 // 唯一，[a-z0-9_-]{1,32}
    /// 预留："stdio"（第一步唯一支持）/ "http" / "sse"。
    /// 现在就放进去，否则将来支持 HTTP 型要做配置迁移。
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,   // 不用 HashMap：要保序且好序列化
    pub cwd: Option<String>,
    pub enabled: bool,
}
```

manifest 单独一张表（不和配置混，因为它是可重建的缓存）：

```sql
CREATE TABLE mcp_manifest (
  server      TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,   -- command + args + env 键名 的摘要，变了就作废
  server_info TEXT,            -- JSON
  instructions TEXT,
  tools       TEXT NOT NULL,   -- JSON 数组（含完整 inputSchema）
  fetched_at  INTEGER NOT NULL
);
```

---

## 11. 失败降级

| 情形 | 行为 |
|---|---|
| 命令不存在 | `state: not_installed`；**不影响 cc-bridge 其他一切**，也不影响其他 server |
| 握手失败 / 超时 | `state: failed` + 原始错误原文；带退避重试（至少间隔 30s） |
| 无 `tools` 能力 | `state: unsupported`，不再尝试 |
| 子进程中途死亡 | 标死连接，下次调用重建；已在飞的调用返回明确错误 |
| manifest 缺失/过期 | `mcp_list_servers` 标 `state: stale` 并提示刷新；不自动启进程 |
| 总开关关 | 两个工具**仍注册**，调用返回“未启用” |

最后一行很重要：**内置工具列表必须是静态的**，否则就碰上了 `WRITE_SET` 那个 `OnceLock`。

---

## 12. 测试

| 编号 | 用例 | 层次 |
|---|---|---|
| B1 | 命令解析：Windows 下能从 PATH 找出 `.cmd`；找不到时报明确错误 | 单测 |
| B2 | 假 MCP server（Rust 测试辅助 bin，读一行回一行）跑完整握手 | 集成 |
| B3 | 假 server 向 stdout 吐非 JSON 日志 → 跳过并仍拿到响应 | 集成 |
| B4 | 假 server 吐**非 UTF-8 字节** → lossy 解码，连接不断 | 集成 |
| B5 | 假 server 握手后不回包 → 超时、连接标污染、下次调用重建 | 集成 |
| B6 | 假 server 回一个**不同的 protocolVersion** → 按它的来 | 集成 |
| B7 | 假 server 不声明 `tools` 能力 → `state: unsupported` | 集成 |
| B8 | 假 server 不响应 EOF → 3s 后 JobObject 兜底杀掉，无残留进程 | 集成 |
| B9 | manifest：抓取→存库→`mcp_list_servers` **不启进程**就能返回 | 集成 |
| B10 | fingerprint 变了（改 args）→ manifest 标 stale | 单测 |
| B11 | 导入：解析一份含三种形态的 `.claude.json` 样本 → 三条都出来且 `enabled=false` | 单测 |
| B12 | 导入：env 值不出现在任何输出里 | 单测 |
| B13 | 只读模式下 `mcp_proxy` 被拒、`mcp_list_servers` 仍可用 | 集成 |
| B14 | **自我排除**：command 指向 `current_exe()` 、以及 http URL 指向本机监听地址，两种写法都要被认出并拒绝（导入时 + 保存时各一次） | 单测 |
| B15 | 自我排除**不靠名字**：名为 `cc-bridge` 但实际指向别的程序 → 不该被误排；名为 `foo` 但指向自身 → 必须被排 | 单测 |

B2–B8 都靠那个假 server，**不依赖本机装了任何真实 MCP**——CI 里能跑。

---

## 13. 不做什么（显式划界）

- 不做 `mcp__x__y` 扁平化（第二步，但本步已为它铺好 manifest）
- 不改 `ToolSpec` / `WRITE_SET` / `http.rs`
- 不引 rmcp
- 不支持 HTTP/SSE 型 MCP server（配置预留 `transport` 字段）
- 不做自动安装
- 不做空闲关停、不做 manifest 定期刷新
- 不支持外挂 server 的 resources / prompts / 采样（只做 tools）
- 不与 `~/.claude.json` 建立持续同步（只一次性导入）
- 不声称外挂受白名单保护

---

## 14. 工期

| 阶段 | 内容 | 估时 |
|---|---|---|
| 1 | `spawn.rs` 命令解析 + JobObject 接入 + B1 | 0.5 天 |
| 2 | `client.rs` 协议实现（含版本协商/能力检查/健壮性）+ 假 server + B2–B8 | 1.5 天 |
| 3 | `manifest.rs` 抓取与持久化 + B9–B10 | 0.5 天 |
| 4 | `mod.rs` 连接池/生命周期 + 两个工具 + B13 | 0.5 天 |
| 5 | `import.rs` + B11–B12 | 0.5 天 |
| 6 | 配置存储 + Tauri 命令 + 设置页 UI（含导入向导与二次确认） | 1.5 天 |
| 7 | 真机联调（远程 Claude Code → cc-bridge → 3 个真实 server）+ 文档 | 0.5 天 |

**合计 5.5 天**（不含第二步扁平化）。

比上一版的 3.5 天多出 2 天，全部花在“通用”上：manifest 持久化、导入、协议协商与健壮性。
这两天不能省——省了就只是个“codegraph 专用桥”。

---

## 15. 已定决策（2026-08-07 确认）

| # | 决策 | 理由 |
|---|---|---|
| 1 | `external_mcp_enabled` **默认 false** | 与 `shell_enabled` 一致。它等于给远程多开一条执行通道，升级同步不得静默改变能力边界 |
| 2 | **不加** `readonly_safe`，第二步再说 | 第一步只读模式下 `mcp_proxy` 全拦。宁可不好用，不能先开一个自己都说不清语义的口子 |
| 3 | `cwd` **可选**，从导入源带过来；不填则继承 cc-bridge 进程的工作目录 | 必填会阻断导入（已有配置很多本来就不写 cwd），而“给个默认子目录”对 codegraph 这类需要指向代码库的 server 没意义 |
| 4 | 导入**含** `projects.*` 下的项目级 server，UI 上标明来源项目 | 本机 `.claude.json` 目前只有全局的，但别的机器上有；漏扫比多扫更难排查 |

两个跟着新增的细节：

- 决策 3 意味着 `cwd: None` 时子进程继承 cc-bridge 的工作目录。那个目录**不在白名单控制下**，
  所以设置页在 `cwd` 为空时要把实际生效的目录**显示出来**（同 S0 的“让用户看得见”原则）。
- 决策 4 意味着同一个 `name` 可能在多个项目里重复出现。导入时碰重名则**自动加项目后缀**
  （如 `filesystem-myapp`），不静默覆盖——覆盖会让用户以为启用的是 A 实际启用的是 B。

遗留到第二步的：扁平化、HTTP/SSE 型 server、空闲关停、`readonly_safe`。
