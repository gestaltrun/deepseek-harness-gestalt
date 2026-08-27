# Agent Note: 让 Mobile App Store 校验具备确定性

Status: implemented

[English](2026-08-27-mobile-app-store-validation.md) | 中文

## Problem

通用 iOS 应用声明支持 iPhone 和 iPad。仅包含竖屏的 iPad 方向列表无法通过 App Store 多任务校验，而带本地时区缩写的描述文件日期也无法由发布脚本可靠解析。

## Decision

iPhone 应用继续仅支持竖屏。iPad 应用声明竖屏、倒置竖屏、向左横屏和向右横屏，使通用包支持 iPad 多任务。iOS 发布脚本通过 `plutil` 将 `ExpirationDate` 读取为 ISO 8601 UTC 值，并在不依赖 runner 语言区域与时区的情况下比较 epoch。导出前，发布脚本验证归档应用中的屏幕方向列表，而不是只信任源 plist。

## Alternatives considered

**将应用限制为 iPhone。** 拒绝，因为提交到仓库的 Xcode target 明确同时支持 iPhone 和 iPad，缩小设备族会移除现有发布目标。

**设置 `UIRequiresFullScreen`。** 拒绝，因为 Apple 将其视为已弃用的兼容模式，并计划在未来版本中忽略它。

**要求发布 runner 使用 UTC。** 拒绝，因为描述文件有效性由发布脚本负责，不应依赖未记录的宿主机设置。

## Consequences

iPad 界面可在 App Store 多任务校验接受的全部方向中旋转和调整尺寸，手机界面仍仅支持竖屏。不同语言区域的发布 runner 会以相同方式解释同一描述文件的到期时间。Mobile UI 的变更必须在 iPad 横屏和多任务尺寸下保持可用。

## Testing

Companion 发布测试固定手机与 iPad 各自的方向列表，在 macOS 的非 UTC 中文区域设置下执行 UTC 描述文件日期解析器，并执行发布方向验证器。签名发布工作流检查归档应用，并提供最终 App Store bundle 校验与 TestFlight 上传证据。
