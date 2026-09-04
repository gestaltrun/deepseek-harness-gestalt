# Agent Note: 交付 ui-phone 插件设置卡向导

Status: implemented

[English](2026-08-28-ui-phone-settings-wizard-card.md) | 中文

## Problem

Issue #360 要求在已有 `packages/client/ui-phone` 上落地 [settings-card.html](../../../../design/device-dock/settings-card.html) 的六态「手机设备」设置卡——关闭、探测中、Android 向导、iOS 向导、就绪清单、三种可恢复错误行。检测数据在 Host `ctx.phoneDevices` 上，本票不得改 phone-runtime，且 tool-phone 尚未存在。插件配置标签页只派发 `settings.plugin.item` 键与 Host 已服务命名空间对齐的卡片，没有这条接合键的卡片永远不会出现。

## Decision

Node 半边通过 `ctx.inject(['settings'], …)` / `settings.register` 注册持久化 `ui-phone` 分区（`enabled: boolean`，默认 `false`），模式与 ui-theme、ui-browser 相同。浏览器半边拥有六态向导外观；承载它的页面是[设置分区笔记](2026-08-28-ui-phone-settings-section.zh.md)记录的顶层「手机设备」分区。卡片是纯 props 组件，按 `PhoneEnvironmentView` 切换；命令行复制锁定稿中的字符串（`sdkmanager --install …`、`avdmanager create avd …`、`emulator -avd Pixel_6_API_35`、`xcodebuild -downloadPlatform iOS`、`xcrun simctl create …`），经注入的 `onCopy` 写出。错误行共用一个动词「下一步动作」。检测走窄接口 `PhoneEnvironmentSource`；随包的 `MISSING_PHONE_ENVIRONMENT_SOURCE` 是 `phoneDevices` 缺失时的探测失败行。本包不 import `phone-runtime`。

## Alternatives considered

**把卡片放进 ui-settings-plugins，与终端 / Agent 循环并列。** 拒绝：cookbook 的接合键是插件自己的命名空间；卡片若离开本包，会把 Host 注册与浏览器外观拆开。

**从 phone-runtime 导入 `PhoneDevices`，在卡片内探测。** 拒绝：本票禁止改 phone-runtime；浏览器半边不能把 Host 服务当值导入；服务缺失时仍须渲染探测失败行。

**只保留 `Config.enabled`、跳过 Host `settings.register`。** 拒绝：插件配置标签页不会派发 Host 未服务的命名空间上的卡片。

**为每种错误手写动词（安装指引 / 打开 Android 向导 / 构建 WDA）。** 拒绝：本票评审建议 #2 把失败动词统一为「下一步动作」。

## Consequences

「手机设备」分区现已包装选择器使用的同一条 Host `GET /phone/devices` 清单：成功拉取可到达探测中、两端向导与就绪态，缺失的设备路由仍停在探测失败行。`enabled` 为 false 时仍不注册设备工具；本包仍不拉起 mobilecli。Tab 条读取 `PhoneListingSource`，见[骨架笔记](2026-08-27-ui-phone-tab-skeleton.zh.md)。
