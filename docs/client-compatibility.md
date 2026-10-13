# MCP Client 兼容性矩阵（P2）

接入向导（连接页）按此口径渲染兼容性徽章（同源常量：`desktop/src/lib/mcpClients.ts` 的 `CLIENT_SELFSIGNED`）。实测推进后**两处同步更新**。

## 支持的接入工具

| 工具 | 配置载体 | 片段形态 | HTTP | SSE | HTTPS 自签 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude mcp add` CLI 命令 | command | ✅ | ✅ | ✅ 可信任 · `NODE_EXTRA_CA_CERTS`（已实测） | 全局/项目两种 scope；`curl` 生态，信任自签路径明确 |
| WorkBuddy | `~/.workbuddy/mcp.json` | JSON | ✅ | ✅ | 🟡 需额外步骤 · `NODE_EXTRA_CA_CERTS`（文档依据，待实测） | 基于 `@modelcontextprotocol/sdk`（Node/undici）→ 走 Node 证书库；`mcpServers.url + headers` 形态；改完重启生效 |
| Codex | `~/.codex/config.toml` | TOML | ✅ | ❌ 不支持 | 🟡 需额外步骤 · `CODEX_CA_CERTIFICATE` → `SSL_CERT_FILE` → 系统根证书（文档依据，待实测） | 仅 streamable HTTP；`[mcp_servers.cc-bridge]` + `url` + `http_headers`（或 `bearer_token_env_var`）；旧版本需顶层 `experimental_use_rmcp_client = true`；`codex mcp list` 验证 |
| 通用 MCP 工具 | 各工具的 MCP 设置界面 | JSON（裸 url+headers+transport） | ✅ | 视工具 | 🟡 需额外步骤 · Node 系 `NODE_EXTRA_CA_CERTS` / Rust 系 `SSL_CERT_FILE` | 任何支持 Streamable HTTP 的客户端 |

图例：✅ 可信任 · 🟡 需额外步骤（可信任，但需手动信任证书）· ⛔ 不支持自签（只能反代 + Let's Encrypt）
三态口径与接入向导徽章一一对应（`CLIENT_SELFSIGNED` 的 `level`）；标「文档依据」的条目尚未真机实测。

## SSE 传输限制

桥端「设置 › 网络 › MCP 传输协议」切到 SSE 后，URL 变为 `/mcp/sse`。**Codex 不支持 SSE 传输**——接入向导会在 SSE 模式下对该工具显式提示，要求先切回 HTTP。

## HTTPS 自签证书（P1）

> 接入向导里的自签徽章与「信任步骤」**只在 HTTPS 远程访问开启时渲染**（HTTP 模式整块不出现，
> 收口口径 `get_tls_status.enabled`）——证书是 HTTPS 的伴生概念。

- 证书：rcgen 自签，825 天，SAN = 全网卡 IP + 127.0.0.1；指纹见「设置 › 安全 › HTTPS 远程访问」，接入侧请核对指纹防中间人。
- **信任做法**（与向导「信任步骤」同源）：
  - **Claude Code**（已实测）：导出证书 PEM（向导「复制 PEM」按钮，后端 `read_tls_cert_pem`）保存为 `cc-bridge.crt`，启动前设 `NODE_EXTRA_CA_CERTS=/path/cc-bridge.crt`。
  - **WorkBuddy**（文档依据，待实测）：基于 `@modelcontextprotocol/sdk`（Node/undici），走 Node 证书库 → 同样认 `NODE_EXTRA_CA_CERTS`，在启动 WorkBuddy 前指向 `cc-bridge.crt`。
  - **Codex**（文档依据，待实测）：**优先 `CODEX_CA_CERTIFICATE`**（PEM bundle），未设时回退 `SSL_CERT_FILE`，再回退系统根证书；Codex 会校验证书，不信任即拒连。
  - **通用工具**：Node 系认 `NODE_EXTRA_CA_CERTS`；Rust 系常认 `SSL_CERT_FILE` 或系统根证书。
- **无法信任自签时**：改用**反向代理 + Let's Encrypt**（全工具无感信任），模板见 [reverse-proxy.md](./reverse-proxy.md)。
- 指纹随时可重置：设置页「重新生成」。

## 已知注意点

1. **IP 变化**：DHCP/VPN 重连后 IP 变化，连接页 banner 给出 sed 命令原地更新（匹配段同时覆盖 http/https，TLS 切换后也能修）。
2. **Token 重生成**：TokenManager 的 sed 只替换 Bearer，与 scheme 无关，各工具通用（前提：该工具的配置文件里嵌了 token）。
3. **Codex 启动超时**：`startup_timeout_sec` 默认 10s；桥冷启动慢时可调大。
4. 工具支持度以「先直连、失败上反代」为排障顺序。
5. **亮色主题 × Claude Code**：Claude Code 自带主题系统（默认 dark），用户消息块的底色由它用 truecolor 硬画，不跟随终端 ANSI 色盘；它的 `theme: auto` 靠 OSC 11 查询探测终端背景，而 xterm.js 不应答该查询。桥端已在终端数据流里代答 OSC 10/11（按当前主题返回前景/背景色），所以 `theme: auto` 现在能正确跟随桥的亮暗主题；若远端 Claude Code 版本过旧无 auto 模式，在会话里手动 `/theme light` 即可。
