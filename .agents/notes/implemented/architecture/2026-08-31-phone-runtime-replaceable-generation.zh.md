# Agent Note: 可替换手机运行时 generation

Status: implemented

[English](2026-08-31-phone-runtime-replaceable-generation.md) | 中文

## 问题

托管 mobilecli 准备在 Desktop 组合完成后结束，而 `PhoneDevices` 原先在整个 Service 生命周期中只解析一个可执行文件并持有一个 child。仅在准备完成后挂载 phone-runtime、phone-stream 与 tool-phone 会要求重启 Desktop；在 child 就绪前保留工具注册则会宣告无法执行的操作。

## 决策

`PhoneDevices` 保持一个 Cordis Service 身份，并持有可替换 mobilecli generation。`activateExecutable(path)` 会 abort 上一 generation 的 IO，排空启动与 poll，停止 child 进程，发布携带精确 removals 的空清单，再为替代 generation 开始就绪探测。`deactivate()` 执行同一停止流程而不销毁 Service。`isReady()` 与 `onReadinessChanged()` 暴露已提交的 generation 状态。

`tool-phone` 仅在 fleet 就绪时注册全部六个延迟 definition，并在 not-ready 迁移时 dispose 全部六个。早于 readiness 接口的实现保留静态注册，使 Service Definition 在托管 Desktop 组合之外仍可使用。

Generation removal 是普通清单发布，而非静默重置 cache。因此包 invariant 在替换之间观察一条连续清单历史，GUI/stream Consumer 不能把已停止 child 的设备继续保留为当前设备。

## 考虑过的替代方案

**准备后重启 Desktop。** 拒绝，因为设置页准备是实时产品操作，Host 持有足够的生命周期状态，只需替换 mobilecli child。

**替换 `phoneDevices` Service 实例。** 拒绝，因为 phone-stream、tool-phone 与订阅者通过 Cordis effect 绑定 Service；替换其身份会把 remount 协调扩散到所有 Consumer。

**始终注册工具，并让每次执行在未就绪时失败。** 拒绝，因为工具发现会宣告不可用能力，持久 loaded-tool 重建也会在 generation 停止后保留它们。

## 后果

准备、版本替换、关闭与 teardown 共用一条达到进程 quiescence 的 child 停止路径。运行时 readiness 成为面向模型手机工具的唯一注册条件。Android/iOS 平台准备不属于本决策；它们提供前置条件后，可以激活同一个稳定 fleet。
