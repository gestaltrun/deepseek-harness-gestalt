# @deepseek-ai/dsh-phone-environment-android

[English](README.md) | 中文

这是注册到 `ctx.phoneEnvironment` 的 Android 平台 Provider。它从 `ANDROID_HOME`、`ANDROID_SDK_ROOT`、Host 默认位置或 `sdkmanager` 路径探测兼容且可写的 Android SDK；兼容安装会被复用，否则准备到 `$DSH_HOME/phone/android/sdk`。默认 AVD 始终位于 `$DSH_HOME/phone/android/avd`，只有 mobilecli 子进程收到两个根目录，不修改用户的 `PATH`。

托管命令行工具清单固定 Google build `15859902`，覆盖 macOS arm64/x64、Windows x64 与 Linux x64，并记录精确下载 URL、字节长度和 SHA-256。准备流程通过 `sdkmanager` 安装固定的 `platform-tools`、`emulator` 与 `system-images;android-35;google_apis;<Host ABI>` 包，再通过 `avdmanager` 创建 `Pixel_6_API_35_Gestalt`。Apple silicon 使用 `arm64-v8a`，受支持的 x64 Host 使用 `x86_64`。Google 没有发布所需 Host 工具链，因此 Windows 与 Linux arm64 稳定显示为不支持。

设置页展示 Google 来源、下载信息、16 GB 可用空间要求、SDK 根目录、AVD 标识和 [Android SDK License](https://developer.android.com/studio/terms) 后，准备请求必须携带 `licenseAccepted: true`。探测阶段绝不接受许可。下载和解压使用仅所有者可访问的 staging 目录，校验固定长度和 SHA-256，并只接受 `cmdline-tools/` ZIP 根。失败或取消不会发布 ready，staging 会被删除；已安装的 SDK 包保留为可续装状态。

每次启动前，Provider 都运行 `emulator -accel-check`。Windows Hypervisor Platform 与 BIOS 虚拟化、Linux KVM 安装与用户组权限、不可用的 macOS 虚拟化都会成为 `manual-required` 状态。USB 开发者模式、USB 调试、RSA 信任和 Windows OEM 驱动也保持人工处理。产品启动的 Emulator 进程由 Provider 持有，关闭功能、取消或插件 teardown 都会等待其退出。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `$DSH_HOME/phone` | 私有手机环境根目录，包含托管 Android SDK 与 AVD home。 |

许可、下载、长度、摘要、归档、SDK 包、AVD 创建、启动超时、取消、不支持 Host 与进程失败使用稳定的 `PHONE_ANDROID_*` 错误码。Host 通过带 revision 的完整 `/phone/environment` 快照投影这些状态。

## Model Experience

通过 `dsh-tool-phone` 间接可见。Android 环境 ready 后，选中的 mobilecli generation 会携带托管 SDK/AVD 环境重新启动，因此 GUI、H264 流和模型可见 `device_*` 工具看到同一台真实模拟器。

#### KV Cache effect

在 `dsh-tool-phone` 向模型请求暴露 deferred 手机工具 schema 前没有影响。

## Known Limitations and Deferred Work

- Google SDK 包仍从上游下载，不会被 Desktop 打包或转存。
- Windows hypervisor、Linux KVM 权限、BIOS 虚拟化、USB 调试、RSA 信任和 OEM 驱动需要用户或管理员处理。
- 最终发布验收必须包含真实 API 35 下载、H264 画面、GUI 控制和真实模型 `device_act`；fixture 证据不能替代。
