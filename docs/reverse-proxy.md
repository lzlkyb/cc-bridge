# 反向代理接入指南（HTTPS 远程连接 · 推荐方案）

适用场景：你的 cc-bridge 所在机器**有域名**（或愿意申请一个），希望用正规的 Let's Encrypt 证书而不是自签。

> 无域名 / 内网直连场景：直接在 设置 → 安全 → 「HTTPS 远程访问」开关内置的自签证书即可，
> 证书指纹会在设置页展示，供 client 侧核对。自签在部分 AI 工具上的兼容性见 README「接入矩阵」。

## 为什么推荐反代

| | 桥内置自签 | 反代（Caddy/nginx） |
|---|---|---|
| 证书类型 | 自签（需 client 侧信任配置） | Let's Encrypt（全工具无感信任） |
| 前置条件 | 无 | 一个域名解析到本机 |
| 各 AI 工具兼容 | 参差（见矩阵） | 全部（就是普通 HTTPS） |
| 自动续期 | 到期前 30 天自动重签自签 | Caddy 全自动 |

## 前置：桥侧配置

1. 设置 → 安全 → 确认「HTTPS 远程访问」**关闭**（桥出 HTTP，TLS 交给反代）。
2. 记下桥的监听端口（默认 `7823`）。反代后**建议把桥的 host 改回 `127.0.0.1`**（只收反代流量，公网直接打桥端口打不进来）。
3. 复制 token（设置页或连接页），接入时放在 `Authorization: Bearer <token>`。
4. 开启「401 封禁」（默认开）。若反代在本机，封禁计的是反代的出口 IP——**反代与本机同机部署时所有请求同 IP**，
   阈值不要设太低（默认 5 合理）；反代必须透传 `X-Forwarded-For`（下方模板已配），
   桥的审计日志记录的是 TCP 对端（即反代）地址，这是防伪造的设计（D1），不是 bug。

## Caddy（推荐，Windows 原生可用）

最省事：Caddy 自动申请 + 续期 Let's Encrypt 证书，配置两行。

`Caddyfile`：

```caddyfile
bridge.example.com {
    reverse_proxy 127.0.0.1:7823
}
```

运行：`caddy run --config Caddyfile`（Windows 可注册为服务：`caddy service install`）。

首次运行需要 80/443 端口空闲（ACME HTTP-01/TLS-ALPN 验证），且域名已 A/AAAA 解析到本机公网 IP。
内网无公网入口时用 DNS 验证（需 DNS 插件，见 Caddy 文档），或退回自签方案。

## nginx

```nginx
server {
    listen 443 ssl;
    server_name bridge.example.com;

    ssl_certificate     /etc/letsencrypt/live/bridge.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7823;
        proxy_http_version 1.1;
        proxy_set_header Connection "";        # keep-alive（MCP streamable HTTP 必需）
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;              # SSE 长连接：读超时拉长
        proxy_buffering off;                   # SSE 必须关缓冲，否则流式响应卡住
        client_max_body_size 64m;              # 与桥的 maxFileSizeBytes 对齐
    }
}
```

证书签发用 certbot（`certbot --nginx -d bridge.example.com`）或已有流程。

## 接入命令（以 Claude Code 为例）

```bash
claude mcp add --transport http cc-bridge https://bridge.example.com/mcp \
  --header "Authorization: Bearer <你的token>"
```

其他工具（Cursor / Cline / VS Code）的配置片段见设置页「远程接入」区（一键复制）。

## 常见问题

- **连上但响应卡住（SSE 模式）**：反代没关缓冲（nginx `proxy_buffering off`）或读了超时（`proxy_read_timeout` 拉长）。
- **429 Banned**：同一出口 IP 连续 401 超过阈值。等窗口过期（默认 15 分钟）或调大阈值/关闭封禁重试。
- **502**：桥没在运行，或端口不是 7823。看桥的托盘/连接页状态。
- **想双栈（内网 HTTP + 公网 HTTPS）**：暂不支持同端口双协议；内网走原 HTTP 配置、公网走反代即可并存使用。
