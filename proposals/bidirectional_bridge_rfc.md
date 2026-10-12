# RFC：双向桥 —— 同一个桌面端，装在文件那端，AI 从任意一端连进来

状态：已确认（2026-10-12 拍板，待排期）
日期：2026-10-10（v2：按「只有桌面端一种形态、正反通用」修订，废弃 headless server 路线）
关联：`proposals/rmcp_migration_rfc.md`、`proposals/mcp_2026_07_28_adaption_rfc.md`

## 一、定位：一个桌面端，正反双向

桥只有**一种形态：cc-bridge 桌面端**（Windows x64 + macOS Apple Silicon）。它装在哪台机器上，那台机器的文件 / 终端就成为「可被 AI 安全操作的资源端」；AI 在任意另一端，通过 MCP over HTTP(S) 连进来。

| | 模式 A · 正向（现状） | 模式 B · 反向（新增能力） |
|---|---|---|
| 桌面端装在 | 本地开发机 | **远端机器**（另一台 Windows/macOS） |
| AI 在哪 | 远程（经接入命令连回本地） | **本地**（Claude Code / Cursor / Cline…） |
| 操作谁的资源 | 桌面端所在机器的文件 | 桌面端所在机器的文件 / 终端 |
| 关键差异 | 局域网 / 本机直连即可 | **跨网访问 → 需要 HTTPS 远程连接** |

产品叙事：

> **cc-bridge：装在文件那端，AI 从任何一边连进来。**
> 一个桌面端应用，正反双向；白名单、全审计、误操作可还原。

（英文：Install cc-bridge where your files live — connect AI from anywhere. One desktop app, both directions; whitelisted, fully audited, reversible.）

**好消息**：不需要拆 crate、不需要 headless 二进制。改动集中在 MCP server 的 TLS 层、监听/token 配置、接入向导 UI 与文档——比上一版（core/server 拆分）工程量小一大截。

## 二、需要新增 / 改造的能力

### 2.1 HTTPS 远程连接（核心新增，TLS 默认自签内置）

现状：MCP server 纯 HTTP + Bearer，面向本机/局域网。模式 B 要求跨网可达，不能裸奔。

**TLS 方案（两层并存，设置页可切）：**

- **方案 1 · 桥内置 rustls（默认推荐，无域名场景）**
  - 设置页「远程访问」一键生成自签证书（绑定机器 IP），展示 **SHA-256 指纹**。
  - Client 侧兼容性诚实标注：Claude Code 可用 `NODE_EXTRA_CA_CERTS` 信任自签 CA；Cursor/Cline 支持度实测后写进矩阵（P2 验收物）。**不承诺所有工具可用自签**。
- **方案 2 · 反代终结 TLS（有域名/内网穿透场景）**
  - 文档给 Caddy 两行配置模板（Windows 版 Caddy 原生可用）；桥只出 HTTP，校验 `X-Forwarded-For` 喂给现有 sourceIp 审计与限流。

**监听与鉴权配置化**：
- 监听地址三档：`127.0.0.1`（默认）/ `0.0.0.0`（局域网，现有防火墙放行流程）/ `0.0.0.0 + HTTPS`（公网远程）。
- token 强制：远程访问开启时强制重新生成强 token（复用现有常量时间比较），设置页可轮换。
- 公网安全底线：连续 401 封禁 IP（复用 audit 缓存计数）、现有路径白名单 fail-closed、写类工具可一键关。

### 2.2 反向接入向导（UI）

- 连接页 / 设置页新增「远程接入」区：开关 + 端口 + token 管理 + 证书信息。
- 一键生成接入包：`https://<ip>:<port>/mcp` + token + **按工具生成配置片段**（Claude Code 命令行 / Cursor 步骤 / Cline JSON / VS Code mcp.json），复制即用。
- 展示当前机器的局域网/公网 IP 探测结果，减少「连不上」的排障成本。

### 2.3 多 AI 工具接入矩阵

MCP 是开放协议，桥端协议层零改动；要补的是验证与文档：

| 工具 | 接入方式 |
|---|---|
| Claude Code | `claude mcp add --transport http …`（现有路径） |
| Cursor | 设置 → MCP → 粘 URL + header |
| Cline / Windsurf | `mcpServers` JSON 片段 |
| VS Code (Copilot) | `.vscode/mcp.json` |

P2 交付**兼容性验证矩阵**：至少 Claude Code + Cursor + Cline 三家 × （HTTP / HTTPS 自签）× （文件读写 / 终端 / 大输出 / batch）实测留档。

### 2.4 GitHub 门面改写

- **repo description**：
  > cc-bridge — Install it where your files live; connect AI from anywhere. One desktop MCP bridge (Windows/macOS) for Claude Code / Cursor / Cline… Whitelisted, audited, reversible.
- **topics**：`mcp` `model-context-protocol` `ai-tools` `remote-development` `rust` `security` `claude-code` `cursor`
- **README 重构**：
  1. 首屏 = 双向叙事 + 一张双模式架构图（远程 AI→本地桥 / 本地 AI→远端桥，同一软件）
  2. Quick Start 按模式拆两条 + 「选哪个模式」对照表（AI 在哪 / 文件在哪 / 是否跨网）
  3. 安全模型章节：白名单 / 审计 / 还原 / 远程访问的安全底线
  4. 英文 README（README.en.md）独立阶段
- 顶部一句话（现有「让远程 Claude Code 直接读写你本机文件」）改为双向版。

## 三、分期落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1 HTTPS 远程连接** | rustls + 自签生成/指纹 + 监听/token 配置化 + 401 封禁 + 反代文档 | 跨网（两台不同公网机器）HTTPS 全工具走通；封禁生效 |
| **P2 接入向导 + 多工具矩阵** | 远程接入 UI（R4 设计稿先行）+ 按工具生成配置片段 + 三家实测 | 三家 client 各完成同一套验收脚本，矩阵留档 |
| **P3 门面** | repo 描述/topics + README 双向重构 + 英文版 | README 首屏双模式 + 两套 Quick Start |
| **P4 多桥管理台（暂不排期）** | 桌面端 A 添加桌面端 B 的连接信息，健康监控 + 审计汇总 | 依赖 P1/P2 落地后的真实需求，届时再评估 |

P1 是唯一的后端硬骨头（TLS + 安全强化）；P2/P3 以文档与 UI 为主；P4 单独排期。

## 四、风险与取舍

1. **公网暴露面扩大**是最大风险——默认保守组合（127.0.0.1 + token 强制 + 远程访问显式开启）、401 封禁、HTTPS 强制（模式 B 下不允许裸 HTTP 出公网的选项）。
2. **自签证书兼容性**参差：不承诺全工具可用的 TLS 方案；README 把「有域名走反代」立为第一推荐，自签标注实测矩阵。
3. **桌面端形态跑在远端的现实约束**：远端机器需要有桌面会话（Windows 服务器/RDP 常驻或 macOS 常开）。这是单形态决策的固有边界，README 讲清楚；若未来出现 headless 需求，MCP server 模块本就独立，拆出成本低——但**现在不做**。
4. **体量预算**：安装包 ≤20MB 红线不变；rustls 增量预计 <1MB。
5. **rmcp 迁移 RFC** 与本 RFC 正交，可继续按原节奏推进（P1 动 transport 层时一并评估）。

## 五、决策记录（2026-10-12 全部拍板）

1. **P1 TLS 默认值**：自签内置为默认（设置页一键生成 + 指纹展示），反代文档并列推荐给有域名场景。
2. **P4 多桥管理台**：先不排期，待 P1/P2 落地后有真实需求再评估。
3. **产品名**：沿用 cc-bridge，不改名；仅在描述层面泛化（「cc」不再强调 Claude Code 专属）。

平台范围（2026-10-10 已定）：不规划 Linux 版；桥只有桌面端一种形态（Windows x64 + macOS Apple Silicon），正反双向通用。
