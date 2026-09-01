# Agent Note: 托管 iOS 环境

Status: implemented

[English](2026-09-01-managed-ios-environment.md) | 中文

## Problem

「手机设备」设置页可以列出现有 iOS 模拟器或 iPhone 真机，但不能准备 Xcode 的 iOS 运行时和默认模拟器。复制命令说明无法区分可自动化的 Xcode 操作与仍由用户或操作系统授权的 Apple 授权、签名和设备信任步骤。

## Decision

`phone-environment-ios` 向稳定 `phoneEnvironment` 服务注册一个平台提供方。Host `process.platform` 是权威事实：Windows 与 Linux 发布专属不可用内容，说明 iOS Simulator 与 iPhone 真机控制需要安装完整 Xcode 的 macOS，不显示准备组件或操作，绝不运行 iOS 子进程。macOS 上的提供方探测已选中的完整 Xcode 应用、许可接受、首次启动组件、可用 iOS 运行时、iPhone 设备类型和模拟器清单。

只有 Xcode、许可和首次启动前提都完成后，提供方才运行 `xcodebuild -downloadPlatform iOS`。它选择最新的可用 iOS 运行时和 iPhone 设备类型，创建一台 `DSH Gestalt iPhone`，并通过 `simctl` 启动。一个控制器会在首次通知或异步命令前预留操作。取消会恢复最近一个可操作状态，timeout、signal、退出码、终止错误与输出溢出事实保持独立。模拟器 JSON 使用一 MiB 的 fail-loud 上限，让普通 `simctl` 清单能够完整保留。关闭功能或 teardown 只关闭由提供方成功启动的模拟器，在关闭成功前保留所有权，并为外部启动的模拟器保留运行事实。

Xcode 安装或更新、Apple 许可接受、首次启动授权、Apple ID、系统权限、真机解锁与信任、开发者模式、签名身份和预置描述文件都保持人工处理。产品文案把手机侧组件称为「设备控制代理」，不承诺某一种上游内部实现。

只有当前 mobilecli generation 将精确模拟器列为在线，并且公共 format-specific 画面验证器识别出 MJPEG/JPEG 帧后，稳定服务才发布平台运行就绪。Provider 注册、启用 reconcile 或手动刷新发现运行中的模拟器时，也由同一个事务持有；取消会发布可重试终态，不能直接提升 Provider 快照。只有一键 iOS 准备事务持有操作时，Host 快照才会在 `checking` 中标记 `operation: 'prepare'`，让设置页提供取消入口，但不会把被动刷新呈现为可取消。候选发现与一键 mobilecli 准备会在激活后 reconcile 同一个尚未验证的运行事实，也覆盖先观察到已启动模拟器、后安装 mobilecli 的顺序。mobilecli 不为 iOS 模拟器提供 H264，因此共享的真实流 fallback 会显示实际 MJPEG 格式，不制造 H264 结果。这项画面事实控制设置页就绪；模型工具注册则跟随已启用 fleet 的运行时就绪，每次调用使用实时 fleet 清单。iOS 环境依赖 Android 就绪基础和真实流 fallback，不重复实现其中任何机制。

## Alternatives considered

**由 Desktop 安装 Xcode 或接受 Apple 授权。** 拒绝，因为 App Store 分发、许可、管理员、账号、设备信任和签名决策需要本产品不具备的 Apple 或用户权限。

**通过浏览器平台字符串推断能力。** 拒绝，因为浏览器不是执行 Xcode 的进程，而且平台字符串可能被精简、模拟或转发。Host `process.platform` 持有该事实。

**在 `simctl bootstatus` 后发布 ready。** 拒绝，因为模拟器已启动不能证明活动 mobilecli generation 能列出它并为 GUI 与 Agent 消费方生成画面。

**要求 iOS 模拟器提供 H264。** 拒绝，因为当前 mobilecli 不为模拟器采集暴露该格式。识别 MJPEG/JPEG 并展示实际格式能够保留真实能力，不会虚构 H264 支持。

**关闭功能时停止所有匹配的模拟器。** 拒绝，因为原本已运行的模拟器可能由用户或其他应用持有。提供方只保留它自己启动的模拟器 generation。

## Consequences

方案 C 设置页把可自动化的运行时和模拟器准备与 Apple 控制的人工步骤分离。跨平台 fixture 在不下载大型资源的前提下覆盖所有状态，最终验收仍需真实 iOS 运行时、list 与 boot、可识别画面、GUI tap 与 Home，以及真实模型 `device_act` 调用。iPhone 真机继续使用现有设备控制代理状态和安装失败；本提供方不会宣称信任或签名已经自动完成。
