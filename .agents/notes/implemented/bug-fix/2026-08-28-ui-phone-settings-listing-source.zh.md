# Agent Note: 用 Host 设备清单驱动手机设置卡

Status: implemented

[English](2026-08-28-ui-phone-settings-listing-source.md) | 中文

## Problem

Issue #417 P1 记录：插件配置标签页的「手机设备」卡片始终注入 `MISSING_PHONE_ENVIRONMENT_SOURCE`，因此即便 Host `phoneDevices` 已发布 `GET /phone/devices`，探测中、两端向导与就绪清单仍不可达。K4 记录 `ui-phone` 公开辅助函数（`registry.ts`、`invariant.ts`，以及门禁同时点名的连接/流辅助函数）JSDoc 不完整。

## Decision

卡片与选择器共用同一个 `PhoneListingSource`。`createListingPhoneEnvironmentSource` 把该清单映射为 `PhoneEnvironmentView`：拉取进行中为探测中，列出任何设备即为就绪，macOS 上空清单为 iOS 向导，否则为 Android 向导，仅在首次拉取被拒绝或不可达时落到探测失败行。`PhoneSettingsCardController` 通过 `subscribe` 跟随该源，并在 `enabled` 为 true 时启动一次拉取。`verify-export-jsdoc` 点名的公开辅助函数补齐 `@param` / `@returns`。

## Alternatives considered

**把 `PhoneDevices` 导入浏览器半边。** 拒绝：浏览器半边不能把 Host 服务当值导入；清单路由已经是同源设备面。

**为设置卡再开一次 fetch。** 拒绝：选择器已经拥有 `GET /phone/devices`；第二份 source 会让两个界面失步。

**把 JSDoc 缺口留作基线旧账。** 拒绝：#417 的 K4 把这些导出点名为必须转绿的门禁。

## Consequences

一份成功但为空的清单仍会打开平台向导，因为清单体不携带 adb/SDK/Xcode 探测事实。卡片的视图联合与复制按钮命令仍遵循[设置向导笔记](../architecture/2026-08-28-ui-phone-settings-wizard-card.zh.md)。
