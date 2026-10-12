# P1 拆解：HTTPS 远程连接（双向桥 · 模式 B 的后端地基）

状态：待确认
日期：2026-10-12
上游：`proposals/bidirectional_bridge_rfc.md`（已拍板：自签内置默认 + 反代文档并列）

## 0. 现状盘点（决定改动面）

- `mcp/http.rs`：`spawn_mcp_server` 用 `tokio::net::TcpListener::bind(host:port)` + `axum::serve`；`build_router` 已抽成独立函数（集成测试可绑随机端口真实过网）——**HTTP 路径保持不动，TLS 是并列分支**。
- 依赖：axum 0.8 / tokio 1 / tower-http，**无 rustls / rcgen**，需要新增。
- 鉴权：`security::auth` 中间件（Bearer 常量时间比较）；限流配置已有（`rate_limit_*`）。
- 配置：`config.rs` AppConfig + db.rs 持久化 + `save_config` patch 通道——新字段照既有模式加。

## 1. 依赖增量（3 个 crate）

```toml
axum-server = { version = "0.8", features = ["tls-rustls"] }  # TLS serve（支持 connect_info，与现有 router 复用）
rustls = "0.23"                                               # axum-server 同源版本，指纹计算用
rcgen = "0.13"                                                # 自签证书生成（纯 Rust）
```

体量预估：安装包增量 < 1.5MB（红线 20MB 内安全）。

> 不选手动 accept loop + tokio-rustls 的原因：axum-server 直接吃 `into_make_service_with_connect_info::<SocketAddr>()`，现有 auth/审计拿 peer IP 的链路零改动；手动方案要在 sourceIp 提取上另写一套，容易分叉。

## 2. 新模块 `mcp/tls.rs`（收口所有 TLS 逻辑，守体量红线）

- `ensure_cert(data_dir, ips) -> CertInfo`：`certs/self-signed.crt + key` 不存在或 IP/SAN 不匹配或临近过期（<30 天）时用 rcgen 重新生成；CN=机器名，SAN=探测到的全部网卡 IP + 127.0.0.1，有效期 825 天。**文件权限：Windows 继承 ACL 即可，macOS 0600。**
- `CertInfo`：指纹（SHA-256，设置页展示）、到期时间、SAN 列表、重新生成原因。
- `serve_tls(addr, app, tls_cfg)`：axum-server 绑定，替代 `axum::serve` 分支。
- 单测：证书生成/复用判断（IP 变化触发重生成）、指纹稳定性。

## 3. 配置与命令

**AppConfig 新增**（照既有 save_config patch 模式 + db.rs 落库）：
- `remote_tls_enabled: bool`（默认 false——默认配置必须最保守）
- `remote_ban_enabled: bool`（默认 true）、`remote_ban_threshold: u32`（默认 5）、`remote_ban_window_min: u32`（默认 15）

**Tauri 命令**：
- `get_tls_status` → `{ enabled, fingerprint, not_after, sans, regeneration_hint }`
- `regen_tls_cert` → 重新生成并返回新 CertInfo（IP 变化/怀疑泄露场景手动触发）
- 现有 `restart_mcp_server` 链路自动生效（配置变了重启监听，已有机制）

## 4. 401 封禁（新 `security/ban.rs`，内存态）

- `DashMap<IpAddr, (u32 count, Instant last)>`：auth 中间件 401 时计数，达阈值 → 后续请求直接 429（不进鉴权，防爆破+省 CPU）；窗口过期清零。
- 认证成功清零该 IP 计数。
- **内存态、重启清零**——诚实写进文档，不做持久化（防爆破够用，不做 faile2ban 级别的持久封禁）。
- 仅在绑定 `0.0.0.0` 时激活（127.0.0.1 无意义）。
- 单测：阈值触发/窗口过期/成功清零/429 路径。

## 5. UI（P1 最小面，R4 设计稿先行再接线）

设置页「安全」区追加 **「HTTPS 远程访问」** 小组：
- 开关（remote_tls_enabled）+ 端口复用现有 port 字段
- 指纹卡：SHA-256 短格式展示（hover 全量）+ 到期时间 +「重新生成」按钮
- 一行口径文案：自签证书各 AI 工具兼容性差异提示（详细矩阵 P2 出）

设计稿确认后接线，预计 `SecurityGroup.tsx` 一个文件内完成。

## 6. 反代文档

`docs/reverse-proxy.md`：Caddy（Windows 原生，两行配置自动 Let's Encrypt）+ nginx 模板各一份；说明桥侧需开启「信任 X-Forwarded-For」配置位（沿用现有 sourceIp 链路）。

## 7. 集成测试（沿用 build_router 随机端口真实过网模式）

- HTTPS：rcgen 证书起 TLS server → rustls client（信任自签）请求 /health 与 /mcp 全链路
- 封禁：连续 6 次 401 → 第 7 次得到 429
- HTTP 路径回归：既有测试全部不动、全过

## 8. 实施顺序（每步独立可验证）

1. `mcp/tls.rs` 证书生成 + 单测（纯新增，零风险）
2. `security/ban.rs` 封禁 + 单测（纯新增）
3. `spawn_mcp_server` 加 TLS 分支 + 配置字段 + 命令（动主链路，cargo test 全量验证）
4. 集成测试两条（HTTPS 全链路 / 封禁）
5. UI 设计稿 → 确认 → 接线
6. `docs/reverse-proxy.md` + CHANGELOG

门禁照旧：cargo fmt / clippy --no-default-features / test --no-default-features + 前端四项（若涉 UI）。

## 9. 风险

- **axum-server 0.8 与 axum 0.8 的 hyper 版本匹配**——第 3 步最先验证，不匹配则降级方案（tokio-rustls 手动 accept，多写 ~40 行）。
- **自签在 Cursor/Cline 的实际表现**：P1 不解决、只留好矩阵接口，P2 实测补齐——README 阶段性声明「Claude Code 已验证，其他工具矩阵见文档」。
- rcgen 0.13 API 在 rustls 0.23 下的密钥格式兼容（PKCS8），第 1 步单测覆盖。
