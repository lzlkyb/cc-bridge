# cc-bridge 多平台适配文案

> 基于主稿（article-main.md）改编，保持调性统一、链接一致。
> 统一仓库链接：https://github.com/lzlkyb/cc-bridge

---

## 1. V2EX「分享创造」短帖

**标题**：[分享创造] cc-bridge：让远程 Claude Code 直接读写你本机文件，告别 scp

**正文**：

本地 Windows 写码 + 远程 Linux 跑 Claude Code 的朋友，有没有被 scp 来回传文件折磨过？

我做了个开源小工具 cc-bridge（纯 Rust + Tauri，安装包才 3.4MB）：装在本机，远程 Claude Code 通过标准 MCP 协议就能直接读 / 写 / 搜你本地的文件，不用再 scp 倒腾。

安全方面默认拒绝一切越权：路径白名单 + Token 认证 + 审计日志 + 写前自动备份（误删能还原）。17 个文件工具，含批量操作和 Jupyter 编辑。

只支持同内网 / VPN，别暴露公网。国内下载走 Gitee 镜像，不卡。

GitHub：https://github.com/lzlkyb/cc-bridge

---

## 2. 少数派图文（精简版，需真实截图）

**标题**：远程写码本地存文件：我用 cc-bridge 把 scp 彻底删了

**正文结构**：
- 开头：第一人称"我的情况"——本地 Win、远程 Linux、被 scp 烦了。
- 痛点三段：慢、乱、卡（配 scp 流程图）。
- cc-bridge 是什么：一句话 + 架构简图（配架构图）。
- 上手：下载 → 加白名单 → 复制命令 → 远端连上（配连接页截图）。
- 安全感：白名单 + 审计 + 备份（配安全页截图）。
- 收尾：3.4MB 小而美，链接。

> 少数派对图文质量要求高，3 张真实界面截图必备，建议先补截图再发。

---

## 3. HelloGitHub 投稿模板

**项目名**：cc-bridge
**一句话简介**：让远程 Claude Code 通过 MCP 协议直接读写本地 Windows 文件的轻量桥接工具。
**项目亮点**：
- 替代 scp / SSHFS，远程 AI 直接操作本机文件，无版本混乱。
- 安全默认拒绝：路径白名单 + Token 认证 + 审计日志 + 写前自动备份。
- 纯 Rust + Tauri 2，安装包仅 3.4MB；支持 Gitee 镜像加速下载。
- 17 个文件工具，含批量 batch、Jupyter 编辑、GBK 编码自适应。
**适用人群**：本地 Windows + 远程 Linux 跑 Claude Code 的开发者。
**项目地址**：https://github.com/lzlkyb/cc-bridge

---

## 4. 微信公众号推文（开头钩子 + 节选）

**标题**：别再 scp 了，让远程 Claude Code 直接读写你本机文件

**开头**：
> 你有没有过这种体验：本地 Windows 写代码，Claude Code 在远程 Linux 上跑。每次让它改个文件，都得 scp 传上去、改完再拉回来。大文件慢，小文件烦，还总搞混哪边是最新的。
> 我最近把一个 3.4MB 的小工具装本机上，scp 就再没碰过。

（中段节选主稿「它是什么 / 30 秒上手 / 安全吗」三节，配 2-3 图）

**结尾**：项目开源在 GitHub，搜 cc-bridge，或点「阅读原文」。欢迎留言说说你是怎么解决远程文件同步的。

---

## 5. 微博 / X 短宣发

**版本 A**：
还在用 scp 给远程 Claude Code 传文件？试试 cc-bridge——本机装个小工具（才 3.4MB），远程 AI 就能直接读写你本地文件，有白名单、有审计、误删能还原。告别文件来回倒腾 👉 github.com/lzlkyb/cc-bridge

**版本 B**：
远程写码、本地存文件的中间那层 scp，可以删了。cc-bridge 用 MCP 协议把本机磁盘安全桥接到 Claude Code，17 个文件工具开箱即用。纯 Rust，安装包 3.4MB。github.com/lzlkyb/cc-bridge

---

## 统一收尾话术（各平台复用）

> 装完就回不去的小工具。GitHub 搜 cc-bridge，求 star、求 issue。
> 链接：https://github.com/lzlkyb/cc-bridge
