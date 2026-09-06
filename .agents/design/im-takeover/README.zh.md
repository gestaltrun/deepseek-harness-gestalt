# IM 账号接管设计归档

[English](README.md) | 中文

本目录持久化 IM 账号接管项目的设计输入，供规格与实施票据引用。它不是产品实现，也不重建 `.design/` 工作台。

## 内容

- `scheme-source.md` 是方向已批准的技术方案源稿。规格 PR 的审阅基线为 `origin/master`；实施基线为固定快照 `96d33581128676a469a1587ea85e0339e4853cf0`（非审阅分支祖先，可经前序 head `c2914ed9a5b3a8d51b2c0800d383376705e0da81` 获取）。固定 SHA 接口复核仍未完成。
- `review-pack.html` 是自包含的人工评审图解。
- `prototype/` 包含已认可的高保真 React 原型源码、fixtures、theme token 快照和 package 元数据；运行方式见 `prototype/README.md`。
- `screenshots/` 包含精选纯示例设计截图。

## 版本来源

- 审阅基线：`origin/master`（`5e55fbc0f9e699fa005028d2a591517fc72ba09e`）——规格 PR 从它分出，固定快照不是其祖先。
- 实施基线：固定快照 `96d33581128676a469a1587ea85e0339e4853cf0`，不在审阅分支内。
- 已发布旧 head `c2914ed9a5b3a8d51b2c0800d383376705e0da81` 的祖先链曾包含固定快照；lease 更新后该提交已无分支引用，仅为临时获取路径。本地保留 ref `codex/im-takeover-spec-fixedbase-preserved` 与 `codex/im-takeover-preserved-6d911d` 持有重写前的 head。固定基线的正式发布归同步项目，先于实施完成。

## 后续决策覆盖

归档保留评审历史，但以下后续决策覆盖其中的旧内容：首期只做钉钉 DWS 与旺旺，飞书不预留空驱动或 UI 承诺；新触发在最近安全 step boundary 生效，不强制中断模型或已开始工具；重启沿用普通 Session 默认策略；群聊触发是三项多选，方案采用任一条件满足、重叠批次只提交一次、统计未提交消息、仅在有新消息时按固定间隔触发、提交成功后推进进度；HiQ 只作机制与问题参照，不作为复制来源，其许可不是阻塞项。

## 隐私与可移植限制

原型源码来自此前位于 `/tmp/dsh-im-takeover-approved-20260906-232805/` 的归档。本目录未复制 `node_modules`、缓存或正式 GUI 参考截图；`references/gui/` 可能包含真实会话内容，因此故意未纳入。原型中的账号、群名、买家、消息和示例凭据都是演示数据，不代表真实身份或可用凭据。

`prototype/package.json` 使用 `file:` 引用正式应用 checkout 中的 UI primitives，因此它不是可移植包。不提交锁文件，因为 npm 会把 `file:` 链接按 checkout 目录深度转为相对路径；按 `prototype/README.md` 使用 `npm install`（不用 `npm ci`）。正式应用路径或版本变化时，需要按 `prototype/manifest.json` 的记录重新抓取设计 token 与组件快照。该限制明确保留，不把原型称为可在其他机器运行的产物。
