# RFC：降低 AI 往返 token 消耗 —— 文件直传票据 + 工具扩展

状态：待评审
日期：2026-10-21
关联：`desktop/src-tauri/src/mcp/http.rs`（路由与鉴权）、`mcp/tools/write_files.rs`（路径校验、备份写盘）、`mcp/tools/edit_files.rs`、`mcp/tools/get_command_output.rs`、`mcp/tools/registry.rs`（工具注册）

本文分两部分：

- **第一部分（一~十二节）**：文件直传票据，新增 `prepare_upload` / `prepare_download`。
- **第二部分（十三~二十节）**：其它降低 token 消耗的改造——工具返回图片、文档渲染、写入不回显全文、编辑支持编码、等待后台命令、文件哈希。

两部分的依据都是 2026-10-21 一次真实会话（NC 二开 + 业务流程图 PPT 生成）里实际发生的消耗。

# 第一部分：文件直传票据

## 一、问题

现在 AI 端（Linux）和桥端（Windows）之间传文件只有一条路：`write_files(encoding: "base64")` / `read_files`。**文件的每个字节都要经过模型上下文**：

| 现象 | 实例（2026-10-21） |
|---|---|
| token 成本高 | 一个 169KB 的 pptx，base64 后 225,632 字符，单向传一次就要十几万 token，只能放弃，改在 Windows 上重新生成 |
| 模型抄写出错 | 只传 6KB 的 gzip+base64 脚本，模型抄错 1 个字符（`9al` → `9an`），gunzip 报错，靠分段 md5 比对才定位 |
| 反方向一样贵 | 从 Windows 拿渲染截图回来核对，同样要 base64 进上下文 |
| 扩展名挡住二进制 | 白名单没有 `.pptx/.png/.jpg/.zip/.gz`，连压缩包都写不进去 |

结论：**只加一个「收文件内容」的 MCP 工具解决不了问题**——MCP 工具的参数和返回值必然进上下文。必须让字节走 MCP 之外的通道，MCP 只负责「发票据 + 回报校验结果」。

## 二、方案总览

```
AI 端(Linux)                                cc-bridge(Windows)
  │  1. MCP: prepare_upload(path=D:\...\x.pptx)  ─────▶ 校验路径/扩展名/只读模式，生成一次性票据
  │  ◀───── { url: https://<host>:<port>/transfer/<ticket>, curl 示例 }
  │  2. shell: curl -T x.pptx <url>   ════字节直传════▶ 流式落临时文件 + 边写边算 sha256
  │                                                     → 备份旧文件 → 原子改名 → 审计
  │  ◀───── { ok, bytes, sha256 }
  │  3. 本地 sha256sum 比对，一致即完成
```

- **两个新 MCP 工具**：`prepare_upload`、`prepare_download`。只发票据，不碰文件内容。
- **一个新 HTTP 路由**：`/transfer/{ticket}`（PUT 上传 / GET 下载），挂在现有 axum Router 上，**同一个端口、同一个进程**，不新开服务。
- 网络上没有新要求：MCP 能连通，`/transfer` 就能连通。

## 三、工具 1：`prepare_upload`（AI 端 → 桥端）

### 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 桥端目标绝对路径 |
| `sha256` | string | 否 | 期望的 sha256（hex）。传了就在上传完成时比对，不一致整次作废 |
| `size` | integer | 否 | 期望字节数，用于提前拒绝超限、完成时比对 |
| `overwrite` | boolean | 否 | 默认 `true`；`false` 时目标已存在直接报错 |
| `ttlSeconds` | integer | 否 | 票据有效期，默认 300，上限 1800 |

### 发票据时的校验（与 `write_files` 完全一致，失败直接返回错误、不发票据）

1. `security::path::resolve_safe_path_cached(path, cached_roots, exclude_patterns, whitelist_enabled)`
2. `security::extension::assert_extension_allowed(resolved, allowed_extensions)`
3. 只读模式开启 → 拒绝
4. 传了 `size` 且大于 `max_file_size_bytes` → 拒绝
5. `overwrite=false` 且目标已存在 → 拒绝

### 返回

```json
{
  "ticketId": "u_7f3a…",
  "method": "PUT",
  "url": "https://<host>:<port>/transfer/<ticket>",
  "path": "/transfer/<ticket>",
  "maxBytes": 20971520,
  "expiresAt": "2026-10-21T16:10:00+08:00",
  "curl": "curl -sS -k -T <本地文件> 'https://<host>:<port>/transfer/<ticket>'"
}
```

### PUT `/transfer/{ticket}` 的处理

1. 校验票据：存在、未过期、未使用、方法为 PUT。**先标记已使用再处理**，防并发重放。
2. **流式**写入同目录临时文件 `.<文件名>.ccbridge-upload-<ticketId>.part`，边写边算 sha256、边累计字节数；累计超过 `max_file_size_bytes` 立即中止、删临时文件、返回 413。
3. 完成后比对 `size` / `sha256`（如果发票据时传了），不一致删临时文件、返回 409。
4. 目标已存在且 `backup_enabled` → 复用 `backup::backup_before_overwrite` + `backup::prune_backups`，与 `write_files` 相同。
5. 临时文件原子改名为目标文件；自动创建父目录（与 `write_files` 一致）。
6. 写审计（同 `write_files` 的审计口径，额外记 `bytes`、`sha256`、`via: transfer`）。
7. 返回 `{ "ok": true, "path": "...", "bytes": 169190, "sha256": "...", "backup": "...或 null" }`。

任何一步失败都要删掉临时文件，不留残留。

## 四、工具 2：`prepare_download`（桥端 → AI 端）

### 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 桥端文件绝对路径 |
| `ttlSeconds` | integer | 否 | 默认 300，上限 1800 |

### 发票据时的校验

1. 同上：`resolve_safe_path_cached` + `assert_extension_allowed`
2. 文件必须存在、是普通文件、大小 ≤ `max_file_size_bytes`
3. 当场计算 sha256 和大小，写进返回值

### 返回

```json
{
  "ticketId": "d_91c2…",
  "method": "GET",
  "url": "https://<host>:<port>/transfer/<ticket>",
  "path": "/transfer/<ticket>",
  "bytes": 814933,
  "sha256": "…",
  "expiresAt": "…",
  "curl": "curl -sS -k -o <本地文件> 'https://<host>:<port>/transfer/<ticket>'"
}
```

### GET `/transfer/{ticket}` 的处理

1. 校验票据（方法为 GET），标记已使用。
2. 流式返回文件；响应头带 `Content-Length`、`X-Content-SHA256`（下载时重算或复用发票据时的值，若文件期间被改动则以实际内容为准）。
3. 写审计（读操作口径，记 `bytes`、`sha256`、`via: transfer`）。

## 五、HTTP 路由改动（`mcp/http.rs`）

1. Router 增加：`.route("/transfer/{ticket}", put(transfer_put_handler).get(transfer_get_handler))`（axum 版本若是 0.7 用 `/:ticket`）。
2. **鉴权**：`auth_middleware` 对 `/transfer/` 前缀跳过 Bearer 校验（参照现有 `/mcp/messages` 的 `skip_token` 写法），**改在 handler 里校验票据**。
   - 原因：curl 端不应持有长期 token（之前发现 `run_command` 的 `env` 参数会静默变空，传 token 容易出错；且长期 token 出现在 shell 历史里不安全）。票据一次性、短时效、绑定单个路径和方法，泄露面小得多。
   - 限流和封禁照走：无效票据计入 `inc_auth_denies()` 和 `ban.record_failure(peer_ip)`，防暴力猜票据。
3. **Body 上限**：现有 `RequestBodyLimitLayer` 是整包缓冲、上限 96MB。`/transfer` 必须**流式读取**（`Body` → `into_data_stream()`），由 handler 自己按 `max_file_size_bytes` 截断，不能被全局层整包缓冲。做法：把 `/transfer` 放到单独的子 Router，只套鉴权/限流/并发层，不套 `RequestBodyLimitLayer`，也不套 `jsonrpc_oversize_middleware`（它会把 413 改写成 JSON-RPC 错误，对 curl 没意义）。
4. **压缩层**：GET 下载已压缩格式（pptx/zip/png）时 gzip 无收益，可对 `/transfer` 不套 `CompressionLayer`。

## 六、票据实现

- 票据值：32 字节随机数，base64url 编码；比对用常量时间比较（复用 `auth::verify_token` 的思路）。
- 存储：`AppState` 里加一个内存表 `Mutex<HashMap<String, Ticket>>`，`Ticket { kind: Upload|Download, resolved_path, expected_size, expected_sha256, overwrite, expires_at, used }`。
- 一次性：处理开始即标记 `used`；过期和已用的条目定期清理（发新票据时顺手清即可）。
- 进程重启全部失效，不落盘。
- 同时有效的票据数设上限（如 64），防止被刷爆内存。

## 七、返回 URL 的主机名

工具 handler 拿不到 HTTP 请求，需要在 `mcp_handler` 里把本次请求的 `Host` 头和协议（TLS 开没开）传进工具上下文，用来拼 `url`。拿不到时回退到配置里的接入地址；同时始终返回相对路径 `path`，AI 端可以自己用 MCP 的基础地址拼。

TLS 为自签证书时，`curl` 示例里带 `-k`（或给出 `--cacert <证书路径>` 的写法），与接入向导现有的处理保持一致。

## 八、工具注册（`mcp/tools/registry.rs`）

新增 `prepare_upload.rs`、`prepare_download.rs`，在 `all_tools()` 里各加一个 `register_tool!`，并更新 `registry_has_expected_count_and_schemas` 等测试里的工具数量。建议描述（英文，与现有工具风格一致）：

- `prepare_upload`：
  `Issue a one-time URL for uploading a file to this machine WITHOUT passing its bytes through the conversation. Validates the target path (whitelist, extension, read-only mode) now; then run the returned curl command from your own shell to PUT the file. The upload is streamed, size-limited, sha256-verified, and backs up any existing file before replacing it atomically. Prefer this over write_files with base64 for any binary or large file.`
- `prepare_download`：
  `Issue a one-time URL for downloading a file from this machine WITHOUT passing its bytes through the conversation. Returns the file's size and sha256; run the returned curl command from your own shell to GET it, then verify the hash. Prefer this over read_files for binary files (images, office documents, archives) or anything large.`

## 九、扩展名白名单（配置项，独立决定）

`/transfer` 照样执行扩展名白名单。要真正用起来，需要在配置里加上常用二进制格式：`.pptx .xlsx .pdf .png .jpg .jpeg .zip .gz`（按需取舍）。这是配置变更，不属于本次代码改动，但不加的话新工具对这些文件同样会被拒绝。

## 十、测试清单

- 上传：正常上传 → sha256、字节数一致；目标已存在时产生备份；父目录不存在时自动创建。
- 上传：期望 sha256 不一致 → 409，目标文件不变、无临时文件残留。
- 上传：超过 `max_file_size_bytes` → 流式中途中止，413，无残留。
- 上传：白名单外路径、禁用扩展名、只读模式 → `prepare_upload` 直接报错，不发票据。
- 票据：重复使用 → 拒绝；过期 → 拒绝；PUT 票据拿去 GET（或反之）→ 拒绝；随机猜票据 → 401 且计入封禁。
- 票据：同一票据并发两个 PUT → 只有一个成功。
- 下载：返回的 sha256 与实际文件一致；`Content-Length` 正确；不存在的文件 → `prepare_download` 报错。
- 鉴权：`/transfer` 不带 Bearer 也能用（靠票据）；`/mcp` 原有鉴权行为不变。
- 大文件：20MB 文件上传下载内存占用平稳（验证确实是流式，没有整包缓冲）。
- 审计：上传、下载各留一条记录，含 `via: transfer`；审计里不出现完整票据值。

## 十一、AI 端使用示例

```bash
# 上传：Linux 上生成好的 pptx 传到 Windows
sha256sum flow.pptx                       # 记下本地哈希
# → MCP 调用 prepare_upload(path="D:\\AItool\\aiwork\\方案文档\\x.pptx", sha256="<本地哈希>")
curl -sS -k -T flow.pptx 'https://<host>:<port>/transfer/<ticket>'
# 返回 {"ok":true,"bytes":169190,"sha256":"…"}，与本地一致即完成

# 下载：Windows 上的渲染截图拿回 Linux
# → MCP 调用 prepare_download(path="D:\\AItool\\aiwork\\_pptgen\\flow_ppt.png")
curl -sS -k -o flow_ppt.png 'https://<host>:<port>/transfer/<ticket>'
sha256sum flow_ppt.png                    # 与工具返回的 sha256 比对
```

## 十二、不在本次范围

- 目录/多文件打包传输（需要时 AI 端自己 tar/zip 后传单个文件）
- 断点续传、分片
- 让 Windows 主动连 AI 端（反向网络通道）

# 第二部分：其它降低 token 消耗的改造

## 十三、总原则：优先加参数，少加工具

每个工具的描述和参数 schema 在**每一轮对话**都会随工具列表进入上下文。cc-bridge 现有二十多个工具，再加十个，每轮的固定开销会明显上升。所以：

- 能靠给现有工具加参数解决的，不新开工具（第十五、十六节，以及第十七节里的输出过滤）。
- 真正需要新增的工具：`view_image`、`render`、`wait_command`、`file_hash`，加上第一部分的 `prepare_upload` / `prepare_download`，共 **6 个**。
- 新工具的描述要短，写清「什么时候该用它而不是老办法」，参数尽量少、带默认值。

不建议搬到 Windows 端的能力：联网搜索/抓网页、子代理（AI 端本来就有，重复实现没收益）；NC 编译、查库这类和具体项目绑定的流程（更适合做成 skill 里的脚本，不做成通用 MCP 工具）。

## 十四、工具直接返回图片：`view_image` + `render`（收益最大）

### 问题

本次会话为了核对一张 PPT 的渲染效果：Windows 截图 → Python 转 base64 打印到 stdout（约 18 万字符）→ 输出超限被客户端落成文件 → AI 端解码成 jpg → 再读图。一张图的文本开销是十几万 token，而且每改一次版式都要重来。

MCP 工具结果原生支持图片内容块（`{"type":"image","data":"<base64>","mimeType":"image/png"}`）。客户端会把它当图片交给模型，按图片计费，一张图约一两千 token，比当文本传便宜两个数量级。

目前代码里没有任何工具返回图片内容块（`grep '"image"'` 无结果）。

### 新工具 `view_image`

| 参数 | 类型 | 说明 |
|---|---|---|
| `path` | string | 图片路径（png/jpg/gif/webp/bmp） |
| `crop` | `[x, y, w, h]` | 可选，按原图像素裁剪 |
| `maxWidth` | integer | 可选，默认 1600，等比缩放，控制图片 token |
| `format` | `"png" \| "jpeg"` | 可选，默认 jpeg（质量 80），截图类建议 png |

返回：一个 image 内容块 + 一个 text 内容块（原图尺寸、裁剪/缩放后的尺寸、文件大小）。路径校验同 `read_files`。

### 新工具 `render`

把文档渲染成图片直接返回，省掉 AI 每次手写 Edge 无头命令或 PowerShell 调 Office COM。

| 参数 | 类型 | 说明 |
|---|---|---|
| `path` | string | html / pptx / docx / xlsx / pdf |
| `page` | integer | 可选，第几页/第几张幻灯片，默认 1 |
| `width` | integer | 可选，HTML 视口宽度，默认 1400 |
| `selector` | string | 可选，HTML 只截某个元素（如 `.chart`） |
| `crop` / `maxWidth` | 同 `view_image` | |
| `saveTo` | string | 可选，同时把渲染结果存盘（便于再用 `prepare_download` 拿走原图） |

实现要点：

- HTML：Edge/Chrome 无头模式（`--headless=new --screenshot`）或 CDP。本机已验证 Edge 无头截图可用。
- Office：PowerPoint/Word/Excel COM 导出 PNG/PDF。🔴 **必须新建独立的 COM 实例且只关闭自己打开的文档，绝不调用 `Application.Quit()` 关掉用户已开着的 Office**——本次会话手写脚本就踩了这个坑（`$pp.Quit()` 可能关掉用户正在编辑的 PPT）。PowerPoint 是单实例程序，判断「启动前是否已在运行」，已在运行时只 `Close()` 自己的 Presentation。
- 没装对应软件时返回清晰错误，不要静默失败。
- 渲染超时（默认 60 秒）要能杀掉子进程。

## 十五、写入/编辑不回显全文：`write_files` / `edit_files` 加 `diff` 参数

### 问题

`write_files` 新建文件时用 `diff_utils::unified_diff(&f.path, "", &f.content)` 生成 diff，**等于把整份新内容原样返回**。本次会话写一份 186 行的 RFC，内容进上下文两遍（AI 写一遍、结果回显一遍）。改流程图和方案文档也一样。

### 改法

`WriteFilesArgs`、`EditFilesArgs` 增加可选参数 `diff`：

| 取值 | 返回 |
|---|---|
| `"stat"`（新建文件默认） | 只返回 `+N/-M 行`、新旧字节数 |
| `"hunks"`（覆盖/编辑默认） | 只返回改动的 hunk，每个 hunk 上下文 2 行，总长超过阈值（如 4KB）时截断并注明 |
| `"full"` | 现在的行为 |
| `"none"` | 只返回 `ok` |

默认值的取舍：新建文件的全文 diff 没有信息量（AI 刚写的），默认 `stat`；改已有文件时 hunk 对核对有价值，默认 `hunks` 但设上限。

## 十六、`edit_files` 支持显式编码与出现次数断言

### 问题

1. **编码**：`EditFilesArgs` 没有 `encoding` 字段。GBK 文件能不能正确编辑取决于服务端「编码自动识别」开关（默认关）。NC 项目大量 GBK+CRLF 源码，本次会话改 3 个 Java 文件都只能「写 Python 脚本 → 上传 → 执行」绕过去。
2. **换行**：`edit_files` 按 LF 归一化后匹配，`oldString` 里带 `\r\n` 必然失败，而 `read_files` 却报 `newline: CRLF`，容易误导模型照抄 `\r\n`。
3. **次数断言**：模型改文件前最关心「这段原文是不是恰好出现 N 次」，现在只有 `replaceAll` 开关，本次会话的替换脚本里每条都手写 `assert s.count(a) == 1`。

### 改法

- `EditEntry` 增加 `encoding: Option<String>`：显式传 `"gbk"` 时按 GBK 读、按 GBK 写回，不依赖服务端开关；省略时行为不变。
- 匹配前把 `oldString`、`newString` 里的 `\r\n` 也归一化成 `\n`，写回时沿用原文件换行风格（与 `write_files` 一致）。
- `EditEntry` 增加 `expectCount: Option<usize>`：实际出现次数不等于它时整条报错、不写盘，错误信息给出实际次数和前几处所在行号。

## 十七、等待后台命令：新工具 `wait_command` + 输出过滤参数

### 问题

NC 的 ecj 编译要 3~4 分钟，`run_command` 前台超时只有一两分钟（且超时不杀进程），只能 `background:true` 启动后反复调 `get_command_output` 轮询。查早了拿不到结果，每查一次一轮往返；输出里还夹着大量无用警告（如几十行 `invalid Class-Path header`），要靠 `grep -v` 再跑一次命令过滤。

### 新工具 `wait_command`

| 参数 | 类型 | 说明 |
|---|---|---|
| `handle` | string | `run_command(background:true)` 返回的句柄 |
| `timeoutSec` | integer | 最长等待，默认 120，上限 600 |
| `untilPattern` | string | 可选，输出出现匹配该正则的行即返回（如 `EXIT=\d+`） |
| `tailLines` | integer | 可选，返回最后 N 行，默认 40 |
| `include` / `exclude` | string | 可选，按正则保留/剔除输出行 |

返回：是否已结束、退出码、是否超时、过滤后的输出片段、被过滤掉的行数。

### 现有工具加参数

`run_command`、`get_command_output` 同样增加 `include` / `exclude` / `tailLines`，在服务端过滤后再返回，被剔除的行只报数量。

## 十八、文件哈希与比对：新工具 `file_hash`

### 问题

本次会话回写 newar 后要确认「暂存版 == 目标文件」「原文件没被别人改过」，都是现拼 `cmp` / `md5sum` 的 shell 命令；Windows 的 Git Bash 环境里工具行为还和 Linux 有差异（曾踩过 iconv 截断文件的坑）。

### 新工具 `file_hash`

| 参数 | 类型 | 说明 |
|---|---|---|
| `paths` | string[] | 要计算的文件 |
| `algorithm` | `"sha256" \| "md5"` | 默认 sha256 |
| `compareWith` | string[] | 可选，与 `paths` 一一对应，返回是否逐字节一致 |

返回每个文件的大小、哈希、修改时间，以及比对结果。也可以考虑不新开工具，而是给 `copy_files` 加 `verify: true`（复制后返回两端哈希）——二选一即可，倾向新开 `file_hash`，因为「比对两个已有文件」不涉及复制。

## 十九、实施优先级

| 优先级 | 项 | 理由 |
|---|---|---|
| P0 | 十四 `view_image` | 改动小（读图、缩放、编码成 image 内容块），单次能省十几万 token |
| P0 | 十五 `diff` 参数 | 改动最小（只改返回值组装），每次写文件都受益 |
| P1 | 一~十二 文件直传 | 解决二进制与大文件传输，需要新路由与票据，工作量中等 |
| P1 | 十六 `edit_files` 编码/次数 | NC 项目高频场景，去掉「写脚本绕路」 |
| P1 | 十七 `wait_command` + 过滤 | 长任务轮询次数从多次降到 1 次 |
| P2 | 十四 `render` | 依赖 Edge/Office，需处理 COM 生命周期，工作量较大 |
| P2 | 十八 `file_hash` | 小改进 |

## 二十、第二部分测试要点

- `view_image`：大图缩放后宽度不超过 `maxWidth`；裁剪越界报错；返回内容块类型为 `image`；路径校验与 `read_files` 一致。
- `render`：HTML 指定 `selector` 只截该元素；pptx 指定页码；**用户已打开 PowerPoint 且有未保存文档时调用 `render`，用户的文档不被关闭**；渲染超时子进程被杀。
- `diff` 参数：新建文件默认只返回 stat；`full` 与改造前输出完全一致（回归）；hunk 截断时注明被截断。
- `edit_files`：GBK+CRLF 文件显式传 `encoding:"gbk"` 编辑后仍为 GBK+CRLF、中文无乱码；`oldString` 带 `\r\n` 能匹配；`expectCount` 不符时不写盘并给出行号。
- `wait_command`：命令先于超时结束 → 立即返回；`untilPattern` 命中即返回；超时返回 `timedOut:true` 且进程不被杀；`exclude` 生效并报告剔除行数。
- `file_hash`：与 `sha256sum` 结果一致；`compareWith` 长度不等报错。

---

# 二十一、实施记录（2026-10-21，P0 两项）

## 已落地

### 十五：`diff` 回显档位（`diff_utils.rs` + `write_files.rs` + `edit_files.rs`）

- `DiffMode`：`none` / `stat` / `hunks` / `full` / `auto`，省略参数即 `auto`。
- `auto`：新建文件 → `stat`（只给 `+N/-M 行` 与新旧字节数）；覆盖/编辑 → `hunks`（上下文 2 行，超 4096 字节按**字符边界**截断，并提示改用 `full` 或 `stat`）。
- `none` 时结果里**不出现** `diff` 字段（不是空串——空串会被读成「改了但内容没变」）。
- 档位拼错整次报错并列出合法值，不静默回落 `auto`（静默回落会让调用方以为拿到的是 `stat`）。
- 原文件非 UTF-8 的覆盖仍返回「未生成逐行 diff + 新旧字节数」摘要，与改造前一致（20MB GBK 文件不会把全文当 `+` 行回显）。
- `full` 与改造前的 `unified_diff` 输出逐字节相同（`full_render_matches_legacy_unified_diff` 钉住）。

### 十四：`view_image`（`mcp/tools/view_image.rs`）

- 参数：`path`、`crop: [x,y,w,h]`（原图像素，越界报错）、`maxWidth`（默认 1600，0＝不缩放）、`format`（`jpeg` 默认 q80 | `png`）。
- 返回：`image` 内容块 + 一个 text 块（原图尺寸/格式/字节、裁剪参数、输出尺寸/格式/质量/字节、是否缩放）。
- 扩展名清单独立于 `config.allowed_extensions`：配置里那份默认一个图片格式都没有，若共用会让工具在默认配置下对 `.png` 截图直接报错。路径仍受 `allowed_roots`/`exclude_patterns` 约束，且只读不写。
- 解码前先读文件头拿尺寸，超 6000 万像素直接拒绝并建议用 `crop`——20MB 的文件上限挡不住 8000×8000 的扁平 PNG（解出来 256MB）。
- jpeg 输出前转 RGB（JPEG 无 alpha，RGBA 直接编码会失败）。
- 附带修正：审计的 `resultBytes` 改为**只数 text 块**（http 与 SSE 两个通道同口径）。否则图片块里那段 base64 会让 token 估算虚高两个数量级（一张 200KB 的图 ≈ 27 万「token」）。

## 与本文原判断不一致之处（以代码为准）

1. **十六 的「换行」子项无需改动**：`edit_files` 早已把 `oldString` 归一化后再匹配（`edit_files.rs:193-202`）。现状是反方向的显式约束——`newString` 含 `\r` 直接报错（`:183`）。保留该行为：写入是改写，静默把调用方要求的 `\r\n` 换成别的东西与本模块「宁可拒写也不静默损坏」的原则相冲。
2. **十七 的前半段判断有误**：`run_command` 前台超时**会**杀整棵进程树（`run_command.rs:566-569`，`start_kill()` → TerminateJobObject），且 `timeoutMs` 没有任何上限——传 `300000` 现在就能前台跑 5 分钟。所以 `wait_command` 的真实价值只剩「N 次轮询压成 1 次」和「服务端过滤输出」，排在 `edit_files` 的编码/次数断言之后。

## 未做（按优先级）

- `edit_files` 的 `encoding` / `expectCount`
- `wait_command`，以及 `run_command` / `get_command_output` 的 `include` / `exclude` / `tailLines`
- 第一部分的文件直传（`prepare_upload` / `prepare_download` + `/transfer/{ticket}`）——前置决策见 §七：`ToolRunner` 签名拿不到请求头，得先定「task_local 传 per-request ctx」还是「回退 config.host+port」
- `render`、`file_hash`

---

# 二十二、实施记录（2026-10-21，P1 两项）

## 已落地

### 十六：`edit_files` 的 `encoding` 与 `expectCount`

- `EditEntry`（含 `GroupedEdit` 分组形态）新增两个可选字段。优先级：**显式 `encoding` > 服务端 `encoding_detect_enabled` > UTF-8**。显式值必须能盖住开关——否则「GBK 项目不想为改一个文件去改全局设置」这个用法直接失效。
- 标签在碰文件之前先验：拼错时返回可用标签清单（`utf-8 / gbk / gb18030 / big5 / utf-16le / utf-16be / latin1` 及 encoding_rs 别名），而不是让 `read_text` 抛一句 `Unknown encoding label`。
- `expectCount` 是**断言**，不改变替换规则（是否全替仍由 `replaceAll` 决定）。次数不符时整条拒写且不碰磁盘，错误里给实际次数与前 5 处行号（`位置：第 12、48 行`）。
- 计数策略：`replaceAll` 或 `expectCount` 存在时全量扫描（要真实次数），否则沿用 `take(2)` 早停（E-P0-5）。
- 顺带修掉一处**误导性错误信息**：非 `replaceAll` 的唯一性失败原本复用早停值，永远写「matched 2 times」；现在错误分支重新全量计数，报真实总数。
- 换行子项**仍未改**，理由见 §二十一（`oldString` 早已归一化；`newString` 含 `\r` 是显式拒绝，属取舍不属 bug）。

### 十七：`wait_command` + 输出过滤

- 新模块 `mcp/tools/output_filter.rs`：`include` / `exclude`（正则，**按行**判定，匹配对象不含行尾，所以 `^ERR`、`ERR$` 都符合直觉）+ `tailLines`。先过滤再截尾；`split_inclusive('\n')` 拼接，CRLF 与末尾空行原样保留。
- 无参数时 `is_active()` 为 false，`apply` 原样返回同一个字符串——**响应形状与改造前逐字段一致**，不会平白多出两个 0。
- 正则写错**整次报错**（不静默当成「不匹配」，那会让调用方以为过滤生效了）。
- `run_command`（前台）、`get_command_output`（本次增量）接入同一份过滤器；`get_command_output` 的 `tailLines` 作用在 offset 之后的那一段，不是整份缓冲。
- `wait_command`：`timeoutSec` 默认 120 / 上限 600（0 = 只看一眼）；`untilPattern` 命中即返回，返回值用 `matchedPattern` + `running` 说明「命中了但命令还在跑」；**超时不杀进程**（`timedOut:true` + `running:true` + `note`）。
- 轮询间隔 100ms；`untilPattern` 每跳对累积缓冲重扫（上限是 `maxOutputBytes`，默认 1MB）。没做增量扫描：跨缓冲边界的匹配要单独设计，收益不抵风险。

## 偏差与取舍

1. **`run_command` 的过滤参数对 `background=true` 无效**（那一刻还没有输出）。没有在运行时塞提醒字段，而是写进 `run_command_description`——模型读的是描述，多一个字段反而是噪音。
2. **`wait_command` 默认 `tailLines=40`**：新工具的响应一定会带 `stdoutOmittedLines`。这与「老工具零参数零改动」的原则不冲突——那条约束只针对既有工具。
3. **过滤统计字段全部用 `DroppedLines` / `OmittedLines` 两个名字**（分别对应「被正则剔除」与「被 tailLines 省略」），因为两者的含义对排查完全不同，合成一个数会看不出是规则太严还是行数太多。

## 未做

- 第一部分的文件直传（`prepare_upload` / `prepare_download` + `/transfer/{ticket}`）——仍卡在 §七 的前置决策：`ToolRunner` 签名 `fn(Value, &Arc<AppState>)` 拿不到请求头，要么引入 per-request ctx（task_local），要么退回 `config.host + port` 拼 URL（端口转发场景会拼错）。
- `render`（依赖 Edge/Office + COM 生命周期，风险最高）
- `file_hash`（`copy_files` 加 `verify` 与它二选一，倾向新工具）

## 附带修复：`run_command` 的壳层回声从未生效

审计 `run_command` 返回值时发现的既有缺陷（不属于本 RFC 的设计范围，但顺手改掉）：

- 旧实现是 `value.as_object_mut().insert("shell", …)` —— `value` 是 `text_result` 的**包装层**（与 `content` 同级）。MCP 客户端只读 `content` 数组，顶层多余字段被直接丢弃，所以「回声当前壳层」这个功能**一次都没生效过**：模型永远不知道 `shell_type` 是 cmd 还是 bash，用户换壳后仍会按旧语法继续发命令。
- 修法：注入并入 `inject_session_info`，写进 `content[0].text` 内层（与 `sessionId` / `cwd` 同一层），并改用 `info.as_object_mut()` 再写入，避免 `text` 万一不是 JSON 对象时 `info["k"] = …` panic。
- 唯一的行为变化：默认配置（无 session、无 cwd 回退）下 `run_command` 的响应现在必然带 `shell` 字段。`sessionId` / `cwdFallback` / `cwd` 仍按原条件注入，不留 `null` 占位。
- `run_command_description` 补一句「返回中的 shell 字段是本次实际生效的壳层」，让模型在描述与实际不一致时有明确的取值优先级。
- 回归测试：`shell_echo_lands_inside_content_text`（顶层无 `shell`、内层有、无 `null` 占位）、`shell_field_visible_in_real_response`（真跑 `echo`，期望值由 `config.shell_type` 推出）。
