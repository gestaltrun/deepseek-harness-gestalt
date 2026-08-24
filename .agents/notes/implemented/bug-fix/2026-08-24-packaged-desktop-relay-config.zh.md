# Agent Note：把实际运行的 Desktop Relay 配置写入安装包

状态：已实现

[English](2026-08-24-packaged-desktop-relay-config.md) | 中文

## 问题

签名 Desktop 已嵌入实际运行的 Account 身份，但公开 Relay endpoint 与 limit 仍从最终用户的进程环境读取。通过 Finder 或开始菜单启动时不会继承 GitHub Actions runner 变量，因此有效安装包也可能在打开窗口前失败。新增必填 negotiation deadline 暴露了 artifact authority 缺失，但它不是根因。

## 决策

发布 workflow 把公开 Relay WSS endpoint、全部 Relay deadline 与 admission limit 写入 bundled main entry 旁的 `operated-platform.json`。WSS endpoint 从已校验的生产 HTTPS origin 派生。所有随部署变化的数值均由 GitHub Environment 变量持有；仓库不提供隐藏的运行时默认值。构建期与启动期 parser 会拒绝未知字段、非 WSS endpoint、无效整数，以及小于单条最大 Relay message 的 inbound byte limit。产品组合接收 typed Relay 配置，不再读取环境中的 `DSH_REMOTE_RELAY_*` 值。

## 验证

config writer 测试从公开变量创建发布 artifact，并验证派生 WSS endpoint 与 limit。packaged bundle 测试验证完整公开 artifact。packaged Electron smoke 会在启动前同时移除 Platform 与 Relay 运行时变量，证明 shipped artifact 已经足够。

## 考虑过的替代方案

**只在打包 runner 上设置 Relay 变量。** 不采用，因为 runner 变量会让 smoke 通过，却无法覆盖 Finder 或开始菜单启动。

**添加代码默认值。** 不采用，因为 Relay deadline 与 admission limit 会随部署变化，必须保持显式配置。

## 后果

当实际运行的 Relay 配置不完整时，Desktop release 会在配置投影或打包阶段失败。安装后的应用使用经过评审的公开配置启动，且不包含 OAuth secret 或 Relay credential。
