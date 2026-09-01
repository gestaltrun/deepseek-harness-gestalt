# @deepseek-ai/dsh-phone-environment-ios

[English](README.md) | 中文

这是注册到 `ctx.phoneEnvironment` 的 macOS 平台提供方。它读取 Host `process.platform`、已选中的完整 Xcode 应用、Xcode 许可与首次启动状态、可用 iOS 模拟器运行时、iPhone 设备类型和模拟器清单。Windows 与 Linux 返回稳定的不可用状态，不启动任何 iOS 子进程；iOS 模拟器与 iPhone 控制需要装有 Xcode 的 macOS。

只有用户安装或更新完整 Xcode 应用、接受许可并在 Xcode 内完成首次启动组件后，准备操作才可用。提供方可以运行 `xcodebuild -downloadPlatform iOS`、通过 `simctl` 创建产品持有的 `DSH Gestalt iPhone` 并启动它。Xcode 安装或更新、Apple 许可接受、首次启动授权、Apple ID、系统权限、真机解锁与信任、开发者模式、签名身份和预置描述文件都保持人工处理。产品界面把手机侧组件称为「设备控制代理」，不承诺某一种上游内部实现。

提供方会在首次通知前持有唯一命令序列。取消使用有界 SIGTERM/SIGKILL 进程树终止并恢复最近一个可操作状态；timeout、signal、退出码、终止失败与输出溢出保持为不同失败事实。关闭功能或 teardown 会等待活动序列，并只关闭由本提供方成功启动的模拟器，在关闭成功前保留所有权；用户原本已启动的模拟器保持运行并仍归用户持有。跨进程 `simctl` JSON 在明确的一 MiB 上限内完整保留，通过校验后才能成为平台状态。

不支持的 Host、Xcode 缺失或不完整、许可和首次启动要求、运行时下载、模拟器创建或启动、无效命令输出、取消与进程失败使用稳定的 `PHONE_IOS_*` 错误码。Host 通过带 revision 的完整 `/phone/environment` 快照投影这些状态。

## Model Experience

通过 `dsh-tool-phone` 消费的 fleet 间接可见。iOS 环境运行后，选中的 mobilecli generation 会重新启动；只有该 generation 将精确模拟器列为在线并验证出可识别的 MJPEG/JPEG 画面后，才向设置页发布平台就绪。mobilecli 不为 iOS 模拟器提供 H264；GUI 通过共享的真实流 fallback 显示实际 MJPEG 格式。模型工具注册跟随已启用 fleet 的运行时就绪，而非这项画面探测；每次工具调用都从实时 fleet 清单解析设备。

#### KV Cache effect

在 `dsh-tool-phone` 向模型请求暴露 deferred 手机工具 schema 前没有影响。

## Known Limitations and Deferred Work

- Xcode 与 Apple 平台资源仍由 Apple 控制安装和下载；Desktop 不会打包或转存它们。
- Apple 许可、首次启动授权、Apple ID、系统权限、真机信任、开发者模式、签名身份和预置描述文件需要用户处理。
- 最终发布验收必须包含真实运行时下载、模拟器启动、可识别画面、GUI 控制和真实模型 `device_act`；fixture 证据不能替代。
