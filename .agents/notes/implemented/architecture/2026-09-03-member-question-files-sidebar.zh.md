# Agent Note: Member Question references open through Better Sidebar Files

Status: implemented

[English](2026-09-03-member-question-files-sidebar.md) | 中文

## Problem

路由后的成员提问可以携带参考文档。T6 把这些芯片打开到成员提问专用的详情面板文档席位。该预览从不使用 receiving Session 的 Files viewer，因此 markdown、沙箱 HTML 与不受支持的类型会进入第二个产品内 dock。传输 bytes 也没有 receiver 所有的 Workspace path，同名本地文件可能被覆盖或被误打开。

## Decision

Host Session materializer 把传输文档 bytes 写到 receiver 所有的隐藏 Workspace 目录：`.dsh/member-questions/<questionId>/<basename>`。同一提问内冲突的 basename 会加上数字后缀。同名 Workspace 文件永不被替换。receiver ledger 只存 `{ path, reason, cachedPath }` 元数据；文档正文不进入该 JSON 文档。

点击材料芯片只会用 receiving Session id 通过 `ctx.betterSidebar.openFile` 打开该缓存 path。没有 `cachedPath` 的芯片是 no-op：提问 Session path 与同名 Workspace 文件都不会被打开。markdown、沙箱 HTML 与不受支持的类型复用普通 Files viewer。Files editor 标签未注册时，芯片回退到 `ctx.workspaces.openPath` 与 Host 系统打开器。详情面板文档席位不再是产品打开路径。

[receiving Session 物化记录](2026-09-02-receiving-session-arrival-materialization.zh.md) 仍拥有 Host Session 创建与 brief 注入。[Host receiver ledger](2026-08-31-host-owned-member-question-receiver-ledger.zh.md) 仍拥有 persistence、first claim 与 human-turn reservation。

## Alternatives considered

**把 T6 详情面板文档席位保留为产品打开路径。** 否决：markdown、沙箱 HTML 与不受支持的类型已有 Files viewer，第二个 dock 与 stories 33–35 冲突。

**把传输 bytes 写到提问 Session 的 Workspace 相对 path。** 否决：同名本地文件会被覆盖或被误打开。

**把文档正文存进 receiver ledger。** 否决：Companion document transfer 拥有这些 bytes，ledger 已经排除参考正文。

**始终调用 `ctx.workspaces.openPath` 并让 Better Sidebar 拦截。** 否决：缺少 Files viewer 时必须回退到系统打开器且不得出现第二个产品内 dock，芯片必须指名 receiving Session 而不是当前 Session。

## Consequences

接收方通过 receiving Session 的普通 Files viewer 阅读传输副本。同名本地 Workspace 文件保持不变。没有 Files 的组合使用 Host 系统打开器。

## Testing

聚焦 cache 测试钉死隐藏目录写入与同名隔离。receiver ingest 测试钉死 materializer 上的传输 bytes，且 ledger 不含正文。Client 插件测试钉死带 receiving Session id 的 Files `openFile`、系统打开器回退，以及缺少 `cachedPath` 时的 no-op。keyless Web assembled coverage 与所属 snapshot 证明 Files 打开的是 `.dsh/member-questions/<questionId>/`，而不是 Workspace 同名文件。
