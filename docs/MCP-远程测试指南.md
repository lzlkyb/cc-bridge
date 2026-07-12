# cc-bridge MCP 远程功能测试指南

> 本文件是一份**自包含的测试执行说明**，交给运行在 Linux 服务器上的 AI 测试执行体（如 Claude Code）阅读。
> 读完你就应当知道：测什么、怎么连、每一步发什么请求、期望什么结果、如何判定 PASS/FAIL/SKIP，以及最后如何产出报告。

---

## 0. 给测试执行体的总纲（必读）

- **你的身份**：你是运行在 **Linux** 上的黑盒测试执行体。被测系统 cc-bridge MCP 运行在**另一台 Windows 主机**上，通过 HTTP 暴露。你只能通过网络（`curl`）访问它，不能假设自己能直接读写对方磁盘。
- **你的目标**：对 cc-bridge 的 **17 个 MCP 工具** + **协议层** + **鉴权/限流/gzip 等中间件**逐项测试，最后产出一份结构化测试报告（见第 9 节模板）。
- **需要的命令行工具**：`curl`（必需）、`jq`（强烈推荐，用于构造/解析 JSON）。开工前先 `command -v curl jq` 确认；缺 `jq` 就先 `apt-get install -y jq` 或等价方式安装。
- **执行原则**：
  1. **先探测，再测试**：环境（允许目录、扩展名白名单、shell 是否开启、是否只读）未知，必须先用 `list_allowed_roots` 和探测性调用摸清，再决定哪些用例能跑、哪些要 SKIP。
  2. **所有破坏性操作只在测试沙箱目录内**：在允许根目录下建一个 `cc-bridge-mcp-test/` 子目录，全部读写都在里面，测完删除。**绝不**动沙箱以外的任何文件。
  3. **如实判定**：每个用例给出 `PASS` / `FAIL` / `SKIP(原因)`。因环境未开启能力（如 shell 未启用、`.ipynb` 不在白名单）导致的不可测，记 **SKIP**，不是 FAIL。
  4. **失败不中断**：一个用例 FAIL 不要停，继续跑完所有用例，最后统一汇总。

---

## 1. 被测系统简介

cc-bridge 是一个跑在 Windows 上的本地文件/命令桥接服务，把「本地文件系统操作 + shell 命令执行」以 MCP 工具的形式通过 HTTP 暴露给远程 AI 客户端。

| 项 | 值 |
|---|---|
| 传输 | HTTP，**单端点 `POST /mcp`**，请求/响应均为 JSON-RPC 2.0 |
| 健康检查 | `GET /health`（**免鉴权**，带轻量限流：1 秒内 >10 次返回 429） |
| 鉴权 | HTTP 头 `Authorization: Bearer <TOKEN>`，缺失或错误 → **401** |
| 默认端口 | `7823`（绑定 `0.0.0.0`，默认可被远程访问） |
| 协议版本 | `initialize` **回显**客户端传入的 `protocolVersion`；未传则回退 `2025-06-18` |
| 工具数量 | **17 个** |
| 安全闸门 | ①允许根目录白名单 ②扩展名白名单 ③只读模式（默认关）④shell 开关（默认**关**）⑤按来源 IP 限流（默认 100 次/60 秒）|

**必须知道的默认行为（会直接影响测试）**：
- `allowed_roots` 默认**为空**——若运营者没在 cc-bridge 里添加允许目录，**所有文件操作都会被白名单拒绝**。测试前务必确认已添加至少一个允许根目录。
- 扩展名白名单默认含 `.txt .md .json .js .ts .py .rs .html .css` 等常见类型，但**默认不含 `.ipynb`**——所以 `notebook_edit` 相关用例默认会 SKIP，除非运营者手动把 `.ipynb` 加入白名单。
- `shell_enabled` 默认 **false**——`run_command` / `stop_command` 默认被拒。命令执行三元组默认 SKIP。
- 只读模式默认 **false**（写操作可用）；若被开启，所有写工具会被拒。

---

## 2. 开始前：填写连接信息 & 核对前置条件

在 shell 里设置以下变量（**向本次测试的委托人索取实际值**）：

```bash
# 被测 Windows 主机的 MCP 地址（局域网/公网 IP + 端口）
export BASE_URL="http://<WINDOWS_HOST_IP>:7823"
# cc-bridge 连接页显示的访问令牌
export TOKEN="<TOKEN>"
```

**前置条件自检清单**（任一不满足会导致大面积失败，先确认再开测）：
- [ ] cc-bridge 已启动，且服务处于「运行中」。
- [ ] cc-bridge 的 host 绑定为 `0.0.0.0` 或该主机的局域网 IP（不是 `127.0.0.1`，否则远程连不上）。
- [ ] Windows 防火墙放行了 TCP `7823`（或实际端口）。
- [ ] `BASE_URL` / `TOKEN` 与 cc-bridge 连接页显示的完全一致。
- [ ] cc-bridge 已添加**至少一个允许根目录**（否则文件操作全被拒）。

**第一枪——连通性冒烟**（免鉴权，最快确认网络通不通）：
```bash
curl -s "$BASE_URL/health"
# 期望：{"status":"ok","version":"2.2.x"}
```
若这一步就连不上，先排查 IP/端口/防火墙，不要继续。

---

## 3. 请求与响应约定

### 3.1 通用请求信封
```json
{ "jsonrpc": "2.0", "id": 1, "method": "<METHOD>", "params": { ... } }
```
`method` 取值：`initialize` / `notifications/initialized` / `tools/list` / `tools/call` / 其他（→ 方法不存在）。

### 3.2 调用工具（tools/call）
```json
{ "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"<工具名>", "arguments": { ... } } }
```

### 3.3 响应判读（重要）
- **协议级成功**：响应含 `result` 字段。
- **协议级错误**：响应含 `error` 字段，如 `{"error":{"code":-32601,"message":"Method not found: ..."}}`。
- **工具级错误**：注意——工具执行失败**不走** `error`，而是 `result.isError == true`，且 `result.content[0].text` 形如 `"Error: <原因>"`。所以判定「工具是否成功」要看：`result` 存在**且** `result.isError != true`。
- **返回内容**：绝大多数工具把结果**序列化成一段 JSON 字符串**塞进 `result.content[0].text`。要拿结构化数据需**二次解析**该字符串。`notebook_edit` 成功时 `content[0].text` 就是 `"ok"`（非 JSON）。

### 3.4 Windows 路径转义（最容易踩的坑）
被测机是 Windows，路径形如 `C:\Users\alice\proj`。放进 JSON 时反斜杠必须转义为 `\\`。**强烈建议用 `jq --arg` 构造 body**，它会自动正确转义，避免手工拼错。

### 3.5 推荐的 bash 辅助函数（复制到你的 shell 后直接用）
```bash
# 发送任意 JSON-RPC 请求体
mcp() {  # 用法: mcp '<完整JSON请求体>'
  curl -s -X POST "$BASE_URL/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1"
}

# 调用某个工具（用 jq 构造，路径反斜杠自动转义）
tool() {  # 用法: tool <工具名> '<arguments的JSON>'
  jq -n --arg n "$1" --argjson a "$2" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}' \
  | curl -s -X POST "$BASE_URL/mcp" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d @-
}

# 从 tools/call 响应里取出并解析 content[0].text（多数工具的结果）
inner() { jq -r '.result.content[0].text' | jq .; }
```

---

## 4. 阶段 A — 协议层

| A# | 目的 | 请求 | 期望 / 判定 |
|----|------|------|-------------|
| A1 | health 免鉴权可用 | `curl -s "$BASE_URL/health"` | 返回 `{"status":"ok","version":...}` → PASS |
| A2 | initialize 回显协议版本 | `mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'` | `.result.protocolVersion == "2025-06-18"`，且含 `.result.serverInfo.name=="cc-bridge"` → PASS |
| A3 | initialize 缺省版本回退 | `mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'` | `.result.protocolVersion == "2025-06-18"` → PASS |
| A4 | tools/list 返回 17 个工具 | `mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` | `.result.tools \| length == 17`，且每个含非空 `name`/`description` 和 object 型 `inputSchema` → PASS |
| A5 | 未知方法 → -32601 | `mcp '{"jsonrpc":"2.0","id":1,"method":"foo/bar"}'` | `.error.code == -32601` → PASS |
| A6 | notifications/initialized 被接受 | `mcp '{"jsonrpc":"2.0","id":1,"method":"notifications/initialized"}'` | 返回合法 JSON（`.jsonrpc=="2.0"`），不报错 → PASS |

A4 附带核对：`tools/list` 返回的 17 个工具名应与下表完全一致（阶段 B–G 会逐个测）：
`list_allowed_roots, list_directory, read_files, write_files, edit_files, create_directory, remove_directory, delete_files, move_files, copy_files, search_files, batch, notebook_edit, analyze_file, run_command, get_command_output, stop_command`

---

## 5. 阶段 B — 环境发现 & 搭建测试沙箱

### B1 `list_allowed_roots`（**第一个必跑**，read）
```bash
tool list_allowed_roots '{}' | inner
```
**期望**：返回含允许根目录列表、`allowedExtensions`（扩展名白名单）、`maxFileSizeBytes` 等。→ PASS

**从结果中提取并记录**（后续所有阶段都要用）：
- 取**第一个允许根目录**作为测试根 `ROOT_WIN`（Windows 路径）。用单引号存，保留反斜杠：
  ```bash
  # 例：把从上一步结果里读到的根目录填进来（单引号，保留单反斜杠）
  ROOT_WIN='C:\Users\alice\proj'
  SANDBOX_WIN="$ROOT_WIN"'\cc-bridge-mcp-test'
  ```
- 记录 `allowedExtensions` 是否包含 `.ipynb`（决定阶段 E 是否 SKIP）。
- 若允许根目录列表为空 → 阶段 C–G 全部 SKIP，并在报告中提示「运营者未配置允许目录」。

### B2 建沙箱目录（`create_directory`，write）
```bash
tool create_directory "$(jq -n --arg p "$SANDBOX_WIN" '{path:$p}')"
```
**期望**：`result.isError != true`，且随后 `list_directory` 能看到该目录 → PASS。
> 若这里返回只读模式相关错误，说明只读模式已开 → 记录，阶段 D/E/F 的写用例全部 SKIP(只读模式)。

---

## 6. 阶段 C — 只读工具（不修改磁盘）

> 先用 `write_files` 在沙箱里铺几个夹具文件（属于阶段 D 能力，但只读工具依赖它们）。若写被禁（只读模式），则本阶段依赖夹具的用例 SKIP。

铺夹具（允许的扩展名，如 `.txt`）：
```bash
tool write_files "$(jq -n --arg p "$SANDBOX_WIN"'\sample.txt' \
  '{files:[{path:$p,content:"hello needle world\nsecond line\n"}]}')"
```

| C# | 工具 | 请求（args 用 jq 构造）| 期望 / 判定 |
|----|------|------|-------------|
| C1 | `list_directory` | `{path: SANDBOX_WIN}` | 结果含刚建的 `sample.txt` → PASS |
| C2 | `list_directory` 递归 | `{path: SANDBOX_WIN, recursive:true, maxDepth:3}` | 正常返回条目树 → PASS |
| C3 | `read_files` | `{files:[SANDBOX_WIN\sample.txt]}` | 读回内容含 `needle` → PASS |
| C4 | `read_files` 行范围 | `{files:[{path:..., startLine:1, endLine:1}]}` | 只返回第 1 行 → PASS |
| C5 | `search_files` 内容检索 | `{rootPath: SANDBOX_WIN, contentPattern:"needle"}` | 命中 `sample.txt`（结果数组非空）→ PASS |
| C6 | `analyze_file` | `{path: SANDBOX_WIN\sample.txt}` | 返回含 `lineCount` 等分析字段 → PASS |

示例（C3）：
```bash
tool read_files "$(jq -n --arg p "$SANDBOX_WIN"'\sample.txt' '{files:[$p]}')" | inner
```
示例（C5）：
```bash
tool search_files "$(jq -n --arg r "$SANDBOX_WIN" '{rootPath:$r, contentPattern:"needle"}')" | inner
```

---

## 7. 阶段 D — 写工具（均在沙箱内）

> 若阶段 B2/只读探测判定为只读模式，本阶段整体 SKIP(只读模式)。

| D# | 工具 | 操作 | 期望 / 判定 |
|----|------|------|-------------|
| D1 | `write_files` | 写 `w.txt` 内容 `AAA` | `read_files` 读回为 `AAA` → PASS |
| D2 | `edit_files` | 把 `w.txt` 里 `AAA`→`BBB`（oldString 精确匹配一次）| 读回含 `BBB` 不含 `AAA` → PASS |
| D3 | `copy_files` | `w.txt` → `w_copy.txt` | 两个文件都存在 → PASS |
| D4 | `move_files` | `w_copy.txt` → `w_moved.txt` | 源消失、目标出现 → PASS |
| D5 | `delete_files` | 删 `w_moved.txt` | 该文件不再出现在 `list_directory` → PASS |
| D6 | `create_directory` | 建子目录 `sub` | `list_directory` 能看到 `sub` → PASS |
| D7 | `remove_directory` | 删空目录 `sub`（`recursive:false`）| `sub` 消失 → PASS |

示例（D1 / D2）：
```bash
tool write_files "$(jq -n --arg p "$SANDBOX_WIN"'\w.txt' '{files:[{path:$p,content:"AAA"}]}')"
tool edit_files  "$(jq -n --arg p "$SANDBOX_WIN"'\w.txt' \
  '{files:[{path:$p,oldString:"AAA",newString:"BBB"}]}')"
```
示例（D3 / D4）：
```bash
tool copy_files "$(jq -n --arg f "$SANDBOX_WIN"'\w.txt' --arg t "$SANDBOX_WIN"'\w_copy.txt' \
  '{items:[{from:$f,to:$t}]}')"
tool move_files "$(jq -n --arg f "$SANDBOX_WIN"'\w_copy.txt' --arg t "$SANDBOX_WIN"'\w_moved.txt' \
  '{items:[{from:$f,to:$t}]}')"
```

---

## 8. 阶段 E — notebook_edit（条件性，可能 SKIP）

**前置**：仅当阶段 B1 的 `allowedExtensions` 含 `.ipynb` 时才能跑；否则整阶段 **SKIP(.ipynb 不在扩展名白名单)**。

若可跑：
```bash
# 先写一个最小 notebook（.ipynb 也受扩展名白名单约束，故同样需 .ipynb 被允许）
tool write_files "$(jq -n --arg p "$SANDBOX_WIN"'\nb.ipynb' \
  --arg c '{"cells":[{"cell_type":"code","source":"print(1)","metadata":{},"outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5}' \
  '{files:[{path:$p,content:$c}]}')"

# 用驼峰 newSource 改第 0 个单元格（回归点：该字段曾因缺 serde rename 被静默忽略）
tool notebook_edit "$(jq -n --arg p "$SANDBOX_WIN"'\nb.ipynb' \
  '{path:$p, cell:0, newSource:"print(42)", mode:"replace"}')"
```
**期望 / 判定**：第二次调用 `result.content[0].text == "ok"`；再 `read_files` 读回 `nb.ipynb`，其 `cells[0].source` 应为 `print(42)`（**而不是空字符串**）→ PASS。

---

## 9. 阶段 F — 命令执行三元组（条件性，可能 SKIP）

**前置探测**：先跑一次前台命令；若返回 `isError` 且提示 shell 未启用 → 整组 **SKIP(shell_enabled=false)**。
> 注意：命令在**远端 Windows** 上以 `cmd /C` 执行，用 Windows 语法（`echo`、`dir` 等）。`cwd` 必须是允许根目录内的绝对路径。

```bash
# F0 探测 + F1 前台回显
tool run_command "$(jq -n --arg c "echo hello" --arg d "$SANDBOX_WIN" '{command:$c, cwd:$d}')" | inner
# 期望：stdout 含 "hello" → F1 PASS；若报 shell 未启用 → 全组 SKIP
```
若 shell 已启用，继续三元组：

| F# | 工具 | 操作 | 期望 |
|----|------|------|------|
| F1 | `run_command` 前台 | `echo hello` | stdout 含 `hello` |
| F2 | `run_command` 后台 | `{command:"echo bghit", cwd:SANDBOX_WIN, background:true}` | 返回 `handle` 和 `pid` |
| F3 | `get_command_output` | `{handle:<F2的handle>}` | 输出含 `bghit` |
| F4 | `stop_command` | `{handle:<F2的handle>}` | 返回 `killed`（true/或已结束）|
| F5 | `stop_command` 未知句柄（负例）| `{handle:"nope"}` | `result.isError==true` 且提示「未知」句柄 → PASS |

示例（F2 → F3 → F4）：
```bash
H=$(tool run_command "$(jq -n --arg c "echo bghit" --arg d "$SANDBOX_WIN" \
      '{command:$c,cwd:$d,background:true}')" | jq -r '.result.content[0].text' | jq -r '.handle')
tool get_command_output "$(jq -n --arg h "$H" '{handle:$h}')" | inner
tool stop_command       "$(jq -n --arg h "$H" '{handle:$h}')" | inner
```

---

## 10. 阶段 G — batch（一次往返多操作，read）

```bash
tool batch "$(jq -n --arg r "$SANDBOX_WIN" '{operations:[
  {tool:"list_allowed_roots", arguments:{}},
  {tool:"list_directory", arguments:{path:$r}}
]}')" | inner
```
**期望 / 判定**：返回 `executed == 2`，且 `results` 数组含两个子结果 → PASS。
（可选负例）嵌套 batch 应被拒：`operations` 里放一个 `{tool:"batch",...}` → 该子操作报错/被拒。

---

## 11. 阶段 H — 安全与中间件

| H# | 目的 | 请求 | 期望 / 判定 |
|----|------|------|-------------|
| H1 | 缺 token → 401 | `curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/mcp" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` | HTTP `401` → PASS |
| H2 | 错 token → 401 | 同上但加 `-H "Authorization: Bearer wrong-token"` | HTTP `401` → PASS |
| H3 | 正确 token → 200 | 同上但用真实 `$TOKEN` | HTTP `200` → PASS |
| H4 | gzip 响应 | `curl -s -D - -o /dev/null -X POST "$BASE_URL/mcp" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept-Encoding: gzip" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` | 响应头含 `content-encoding: gzip` → PASS |
| H5 | 路径越权被拒 | `tool read_files` 传一个**允许根目录之外**的路径（如 `C:\Windows\win.ini`）| `result.isError==true`，提示白名单/不在允许目录 → PASS |
| H6 | 扩展名白名单被拒 | `tool write_files` 写一个**不在白名单**的扩展名（如 `x.exe`）到沙箱 | `result.isError==true`，提示扩展名不允许 → PASS |
| H7 | 限流 429（谨慎/可选）| 短时间内对 `/mcp` 连发超过 `rate_limit_max_requests`（默认 100/60s）次同 IP 请求 | 超限后出现 HTTP `429` → PASS。**注意**：默认阈值 100 较高，会打满配额影响后续用例，建议放到最后跑，或请运营者临时调低阈值；不便测则 SKIP。|
| H8 | 只读模式（条件）| 仅当运营者开启只读模式时验证：任一写工具 → `isError` 且提示只读 | 相应判定；未开启则 SKIP |

H5 示例：
```bash
tool read_files "$(jq -n '{files:["C:\\Windows\\win.ini"]}')" | jq '.result.isError, .result.content[0].text'
```

---

## 12. 阶段 I — 清理（务必执行）

删除测试沙箱（递归），确保不留垃圾：
```bash
tool remove_directory "$(jq -n --arg p "$SANDBOX_WIN" '{path:$p, recursive:true}')"
# 验证：list_directory 父目录，确认 cc-bridge-mcp-test 已消失
```
> 若因只读模式无法删除，在报告中注明「沙箱残留，需手动清理：<路径>」。

---

## 13. 阶段 J — 输出测试报告

跑完后，按下述模板产出报告（Markdown）。逐项给结论，SKIP 必须写原因。

```markdown
# cc-bridge MCP 远程测试报告
- 被测地址：<BASE_URL>    版本：<health 返回的 version>
- 测试时间：<UTC/本地时间>
- 环境探测：允许根目录数=<n>；.ipynb 白名单=<是/否>；shell_enabled=<是/否>；只读模式=<是/否>

## 结果总览
| 阶段 | 用例 | PASS | FAIL | SKIP |
|------|------|------|------|------|
| A 协议 | 6 | | | |
| B 发现/沙箱 | 2 | | | |
| C 只读 | 6 | | | |
| D 写 | 7 | | | |
| E notebook | 1 | | | |
| F 命令 | 5 | | | |
| G batch | 1 | | | |
| H 安全/中间件 | 8 | | | |
| 合计 | 36 | | | |

## 明细
（逐条列出 用例编号 / 工具 / 结论 / 关键返回或失败原因）

## 发现的问题
（按严重度列出，附复现请求与实际响应）

## 结论
（总体是否可用；哪些能力因环境未开启而未覆盖；建议）
```

**17 个工具覆盖核对**（报告里确认每个都被触达）：
`list_allowed_roots(B1) · list_directory(C1) · read_files(C3) · write_files(D1) · edit_files(D2) · create_directory(B2/D6) · remove_directory(D7/I) · delete_files(D5) · move_files(D4) · copy_files(D3) · search_files(C5) · batch(G) · notebook_edit(E) · analyze_file(C6) · run_command(F1) · get_command_output(F3) · stop_command(F4)`
