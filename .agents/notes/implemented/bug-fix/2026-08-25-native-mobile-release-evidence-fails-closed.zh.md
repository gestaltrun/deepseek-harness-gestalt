# Agent Note：让原生 Mobile 发布证据遇错即失败

状态：已实现

[English](2026-08-25-native-mobile-release-evidence-fails-closed.md) | 中文

## 问题

Android Snow proof runner 在启动已有 Emulator 后只给 report 十秒时间。冷启动 application process 可能需要更长时间完成 bind 与 WebView 初始化，导致 runner 在 `onCreate` 写出第一条 progress record 之前就将其停止。另一方面，Android release packaging 在 `PATH` 中找不到 `apksigner` 时会回退到 `jarsigner`。有效的 v2-only APK 在 `jarsigner` 看来是未签名的，而 `jarsigner` 打印该结果后仍以成功状态退出，因此 packaging script 可能在没有证明 Android APK signature 的情况下报告成功。

## 决策

Android WebView proof 为 cold-start report 提供三十秒，与 iOS WKWebView 的 report deadline 一致。超过该期限仍没有 report 或 progress 时依然失败，并且始终释放一次性 proof application。

Android release packaging 只接受 Android SDK `apksigner` 作为 signature authority。它从 `PATH`、`ANDROID_SDK_ROOT`、`ANDROID_HOME` 或 Gradle 已检查的本地 `sdk.dir` 解析 executable，选择可用的最新 build-tools version，并在找不到 verifier 时失败。`jarsigner` 不是 APK signature verifier，永不作为回退。

## 考虑过的替代方案

**保留十秒 Android deadline。** 拒绝，因为 process 与 WebView cold start 不属于 proof implementation，并且在健康 Emulator 上也可能超过该间隔。

**增加 deadline 但不设置有界失败。** 拒绝，因为缺少 report 必须保持为确定的 release failure，而不是无界等待。

**接受 `jarsigner` exit status。** 拒绝，因为它不验证 APK Signature Scheme v2 或更高版本，而且可能在说明 APK 未签名后仍返回成功。

## 后果

原生冷启动不再制造虚假的 Snow-proof failure，而 stalled runner 仍会在有界时间内失败。Android release job 只有在 Android SDK 验证 APK signature scheme 后才能声称产物已签名。本地与 CI packaging 使用相同的 verifier discovery rule。

## 测试

Runner coverage 证明二十秒后到达的 report 能在三十秒期限内成功，同时保留所有 cleanup failure case。Release coverage 会阻止 `jarsigner` fallback，完整的本地 release script 则使用发现到的 Android SDK `apksigner` 验证 v2-signed APK。
