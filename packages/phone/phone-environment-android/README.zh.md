# @deepseek-ai/dsh-phone-environment-android

[English](README.md) | 中文

这是注册到 `ctx.phoneEnvironment` 的 Android 平台提供方。它从 `ANDROID_HOME`、`ANDROID_SDK_ROOT`、Host 默认位置或 `sdkmanager` 路径探测兼容且可写的 Android SDK；兼容探测要求可工作的 `sdkmanager` 12+、`avdmanager` 与 `pixel_6` 设备定义，否则准备到 `$DSH_HOME/phone/android/sdk`；当发现完全未命中时，提供方会从磁盘探测该托管根目录，使已准备好的安装在重新检测后保持就绪。默认 AVD 始终位于 `$DSH_HOME/phone/android/avd`，只有 mobilecli 子进程收到两个根目录，不修改用户的 `PATH`。

托管命令行工具清单固定 Google build `15859902`，覆盖 macOS arm64/x64、Windows x64 与 Linux x64，并记录精确下载 URL、字节长度和 SHA-256。准备流程通过 `sdkmanager` 安装固定的 `platform-tools`、`emulator` 与 `system-images;android-35;google_apis;<Host ABI>` 包，再通过 `avdmanager` 创建 `Pixel_6_API_35_Gestalt`。Apple silicon 使用 `arm64-v8a`，受支持的 x64 Host 使用 `x86_64`。Google 没有发布所需 Host 工具链，因此 Windows 与 Linux arm64 稳定显示为不支持。

设置页展示 Google 来源、下载信息、16 GB 可用空间要求、SDK 根目录、AVD 标识和 [Android SDK License](https://developer.android.com/studio/terms) 后，准备请求必须携带 `licenseAccepted: true`。探测阶段绝不接受许可。Command-line tools 请求强制 `Accept-Encoding: identity`；最终校验使用实际接收的解码后字节数与 SHA-256，不把压缩响应的 `Content-Length` 当作资产长度。下载和解压使用仅所有者可访问的 staging 目录，并只接受 `cmdline-tools/` ZIP 根。私有 AVD 输出会在创建前清理，并在取消或失败后再次清理，因此上次未写完的内容不会阻塞重试。失败或取消不会发布 ready；已安装的 SDK 包保留为可续装状态。

准备流程只安装 SDK 和私有 AVD，不会自行启动。每次显式启动前，提供方都运行 `emulator -accel-check`。Windows Hypervisor Platform 与 BIOS 虚拟化、Linux KVM 安装与用户组权限、不可用的 macOS 虚拟化都会成为 `manual-required` 状态。USB 开发者模式、USB 调试、RSA 信任和 Windows OEM 驱动也保持人工处理。产品启动的 Emulator 进程由提供方持有，关闭功能、取消或插件 teardown 都会等待其退出；进程意外退出会立即撤销运行就绪状态。停止过程有界，多个生命周期调用方共享同一个任务；Windows 进程树终止失败会显式报错，不会伪称完全停稳。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `$DSH_HOME/phone` | 私有手机环境根目录，包含托管 Android SDK 与 AVD home。 |

许可、下载、长度、摘要、归档、SDK 包、AVD 创建、启动超时、取消、不支持 Host 与进程失败使用稳定的 `PHONE_ANDROID_*` 错误码。Host 通过带 revision 的完整 `/phone/environment` 快照投影这些状态。

## Model Experience

通过 `dsh-tool-phone` 间接可见。Android 环境运行后，选中的 mobilecli 代会携带托管 SDK/AVD 环境重新启动；只有该代将模拟器列为在线并识别出语法有效的 Annex-B key access unit，且其中的 SPS、PPS 与 IDR slice header 相互引用一致后，才发布 ready。Host 探测不解码像素；最终验收仍单独要求 GUI 显示真实画面。启动、重新激活、列举与采集共享同一个取消所有者，因此关闭功能、取消和 teardown 不会发布过期的运行就绪状态。GUI 与模型可见 `device_*` 工具操作的是同一台已验证模拟器。

#### KV Cache effect

在 `dsh-tool-phone` 向模型请求暴露 deferred 手机工具 schema 前没有影响。

## Known Limitations and Deferred Work

- Google SDK 包仍从上游下载，不会被 Desktop 打包或转存。
- Windows hypervisor、Linux KVM 权限、BIOS 虚拟化、USB 调试、RSA 信任和 OEM 驱动需要用户或管理员处理。
- 最终发布验收必须包含真实 API 35 下载、H264 画面、GUI 控制和真实模型 `device_act`；fixture 证据不能替代。
