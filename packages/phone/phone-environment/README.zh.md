# @deepseek-ai/dsh-phone-environment

[English](README.md) | 中文

Host 在 `ctx.phoneEnvironment` 上持有手机工具链状态。该 Service 为「手机设备」设置客户端发布一份不可变全量快照，并在启用开关或活动 mobilecli generation 变化时保持自身身份。共享运行时状态是 missing / downloading / verifying / activating / ready / failed 闭合联合。Android 与 iOS 准备使用各自可扩展状态；非 macOS Host 将 iOS 报告为不支持，不提供无法执行的操作。

托管运行时固定到 mobile-next/mobilecli 官方 GitHub Release 的六个 1.0.5 归档，覆盖 macOS、Windows 与 Linux 的 arm64 和 amd64。包清单记录每个固定 URL、字节长度、SHA-256 摘要与归档内可执行文件名。运行时选择顺序为显式运维 override、托管 current、系统发现。它绝不写入全局 npm 安装或 `PATH`。

mobilecli 使用 FSL-1.1，并带 Apache-2.0 future license。运行时从上游 Release 直连下载不等于把副本放进 Desktop Bundle，但在法务或上游许可方确认预期产品用途获准之前，产品发布仍被阻塞。本包不 vendor 或再分发 mobilecli。

## Model Experience

该 Service 不增加 prompt 或工具 schema。启用的 generation 就绪后，独立的 `dsh-tool-phone` Consumer 可以注册其延迟 `device_*` 工具。

#### KV Cache effect

运行时缺失或关闭时无影响。只有在 `dsh-tool-phone` 下完成工具发现后，延迟手机 schema 才进入请求。

## Known Limitations and Deferred Work

- Android SDK 与模拟器准备归属平台专用 Android 环境包。
- iOS 运行时与模拟器准备归属仅 macOS 可用的 iOS 环境包。
- FSL-1.1 产品用途许可确认仍是 Desktop 发布阻塞项。
