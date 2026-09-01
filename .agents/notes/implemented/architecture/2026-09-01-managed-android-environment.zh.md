# Agent Note: 托管 Android 环境

Status: implemented

[English](2026-09-01-managed-android-environment.md) | 中文

## Problem

「手机设备」设置页可以探测 mobilecli 已有设备，但不能准备 Android SDK、系统镜像或 AVD。Shell 命令把提供方细节暴露给用户，无法建立下载与许可同意，也不能让 GUI 和 Agent 消费方使用的同一 mobilecli 代看到私有 SDK。

## Decision

`phone-environment-android` 向稳定的 `phoneEnvironment` 服务注册一个平台提供方。服务持有完整 revision 快照和可信 HTTP 操作；提供方持有 Android SDK 探测、下载、包安装、私有默认 AVD、Emulator 子进程、取消与 teardown。取消注册会把 Android 平台状态恢复为 `deferred`，不会替换服务 identity。

兼容且可写的 SDK 根目录只有通过可工作的 `sdkmanager` 12+、`avdmanager` 与 `pixel_6` 设备定义探测后才会复用，否则提供方使用 `$DSH_HOME/phone/android/sdk`；AVD home 始终是 `$DSH_HOME/phone/android/avd`。提供方只向选中的 mobilecli 子代提供 `ANDROID_HOME`、`ANDROID_SDK_ROOT`、`ANDROID_AVD_HOME` 与 SDK 工具目录。运行时服务对 server 和一次性 agent 命令使用同一份子进程环境。

Google command-line tools build `15859902` 按 Host tuple 固定，并记录精确的解码后长度与 SHA-256。下载请求使用 `Accept-Encoding: identity`，然后把实际接收字节数与 SHA-256 作为权威校验；压缩响应的 `Content-Length` 不能拒绝已正确解码的资产。读取失败或 body 超长会取消并等待 response reader；取消失败会单独报告，不覆盖主校验失败。包 id 固定为 `platform-tools`、`emulator` 与使用 Host CPU ABI 的 API 35 Google APIs。准备只会在显式接受 Android SDK License 且通过 16 GB 可用空间检查后开始。`sdkmanager` 持有上游包下载与许可文件，提供方持有经过校验的 command-line tools staging 和幂等 `Pixel_6_API_35_Gestalt` AVD。

准备流程只安装 SDK 与 AVD，不会自行启动。提供方在显式启动 AVD 前检查加速能力。Windows Hypervisor Platform、Linux KVM 权限、BIOS 虚拟化、USB 调试、RSA 信任和 OEM 驱动保持为人工要求。产品启动的 Emulator 进程树会在取消、关闭功能或 teardown 时完全停稳，意外退出会撤销就绪状态。运行中的平台状态携带 branded emulator id，并使 mobilecli 携带 Android 环境重新激活；只有 mobilecli 将该 id 列为在线并产出语法有效的 Annex-B key access unit，且其中的 SPS、PPS 与 IDR slice header 相互引用一致后，才成为 ready。Host 探测不解码像素；真实画面的 GUI 验收仍是独立发布要求。启动、重新激活、列举与采集共享同一个取消所有者。

## Alternatives considered

**保留命令复制指引。** 拒绝，因为用户要求产品持有准备过程，而复制命令无法保持下载信任、显式许可同意、生命周期所有权或共享 mobilecli 环境。

**始终安装私有 SDK。** 拒绝，因为兼容且可写的 Android Studio 或 SDK 安装已经包含体积较大的不可变包，不需要重复下载。

**修改用户 PATH 或 shell profile。** 拒绝，因为 Android 工具链只属于一个 Desktop 运行时代，不应改变无关终端或应用。

**自动修改 hypervisor、KVM、USB 信任与 OEM 驱动。** 拒绝，因为这些动作需要 Desktop 不持有的管理员、固件、设备或操作系统权限。

## Consequences

方案 C 设置页在共享 mobilecli 运行时下方分别显示 Android 与 iOS 平台卡。Android 准备展示来源、固定工具 build、SDK 根、AVD 标识、磁盘要求、许可同意、进度、人工要求与重试状态。在线设备行会把所选设备打开到单例「手机」tab；Desktop 先把选择从隔离的设置 overlay 转交给 Session Surface，再展开面板。离线行操作保持禁用，默认模拟器仍由平台卡启动。包测试与 Electron fixture 验证确定性布局和生命周期行为；发布验收仍需要官方下载、真实 API 35 启动、真实 H264、GUI 控制和真实模型工具调用。
