# cc-bridge 发布执行 Checklist

> 全套推进的执行清单。AI 已产出文案与 README 优化，发布动作由你（人类）完成。
> 顺序原则：**先收口页（GitHub），再往外发**，所有渠道统一指向仓库链接。

---

## 阶段 0：发布前准备（人类补物料）

- [ ] 跑一次 cc-bridge，截 3 张真实界面图：① 连接页 ② 安全页白名单 ③ 日志/审计页
- [ ] （可选）录一段演示 gif：复制连接命令 → 远端 Claude Code 读文件
- [ ] 确认 Gitee 镜像地址（若已建），填入 README 与文案
- [ ] 仓库 Topics 补：`mcp` `claude-code` `tauri` `rust` `file-bridge` `windows` `ai-tools`
- [ ] 仓库「About」填中文描述 + 勾选「显示 README 徽章」

## 阶段 1：GitHub 收口页（已完成 README 优化，复核即可）

- [ ] README 开头 Badge 正常显示（stars / license / release / 下载量）
- [ ] 截图占位已替换为真实图（或先保留占位并标注 TODO）
- [ ] 工具数已统一为 17（功能清单表已补 batch / notebook_edit）
- [ ] 快速开始 4 步可读、命令正确
- [ ] 本地预览 README 渲染无错

## 阶段 2：对外发布（按节奏）

- [ ] **第 1 天** 推送 README 优化到 main（收口页就位）
- [ ] **第 2 天** 掘金长文首发（用 article-main.md，配架构图 + 截图）
- [ ] **第 3 天** V2EX「分享创造」短帖（用 article-platforms.md §1）
- [ ] **第 4-5 天** 知乎文章 + 回答 2-3 个「Claude Code 连本地文件 / 远程开发同步」类问题
- [ ] **第 7 天** HelloGitHub 月刊投稿（用 §3 模板）
- [ ] **第 10 天** 少数派图文（用 §2，需先补真实截图）
- [ ] **第 14 天** 公众号 / 即刻短宣发（用 §4 / §5）

## 阶段 3：复盘

- [ ] 记录各渠道数据：GitHub star / clone / Release 下载；掘金阅读；知乎赞同；V2EX 回复
- [ ] 标记高转化渠道，第二轮加投
- [ ] 收集用户反馈（issue / 评论），回流到 `CHANGELOG` 的 Unreleased

---

## 物料清单（本目录已产出）

| 文件 | 内容 |
|------|------|
| `promotion-plan.md` | 渠道清单 + 卖点 + 节奏 + 物料清单 |
| `article-main.md` | 主稿（掘金/知乎长文） |
| `article-platforms.md` | 多平台适配（V2EX/少数派/HelloGitHub/公众号/微博） |
| `release-checklist.md` | 本文：发布执行清单 |
| 根 `README.md` | 已优化（Badge / 价值主张 / 截图占位 / 快速开始 / 工具数 17） |
