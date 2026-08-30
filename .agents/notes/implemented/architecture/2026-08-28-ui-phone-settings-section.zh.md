# Agent Note: 把「手机设备」做成顶层设置分区

Status: implemented

[English](2026-08-28-ui-phone-settings-section.md) | 中文

## Problem

Issue #417 后续验收决定把手机设备配置移出插件页。把六态向导放在终端 / Agent 循环旁边，会把设备被控调试和 Host 插件调参混在一起，导航标签也与「移动伴侣」（人用手机连桌面）冲突。

## Decision

`packages/client/ui-phone` 贡献 `settings.section` `id: phone-devices`，order 40（排在浏览器 35 之后、移动伴侣 50 之前），locale 命名空间 `settings.phone-devices`，导航标签「手机设备」 / Phone Devices。分区主体就是既有六态卡片。Host `settings.register('ui-phone')` 不变。本包不再注册 `settings.plugin.item`。引言用一句话写明与伴侣的区分。

## Alternatives considered

**把向导留在插件配置卡片里。** 拒绝：验收决定要求顶层分区，插件页仍只放 Host 插件调参。

**复用移动伴侣分区。** 拒绝：伴侣是人用手机连桌面；本页是设备被控调试。

**改 Host 命名空间。** 拒绝：只搬家呈现层；持久化 `ui-phone.enabled` 仍是 tab 启用闸门的接合键。

## Consequences

插件配置标签页不再列出手机卡片。向导的视图联合、复制按钮命令与清单驱动源仍遵循[设置向导笔记](2026-08-28-ui-phone-settings-wizard-card.zh.md)和[清单源笔记](../bug-fix/2026-08-28-ui-phone-settings-listing-source.zh.md)。
