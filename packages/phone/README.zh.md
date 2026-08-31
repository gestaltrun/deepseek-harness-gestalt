# phone/ — 手机设备群能力族

[English](README.md) | 中文

以外部 mobilecli 为后端的手机设备群：一个 Host 半区服务负责回环服务子进程、健康轮询与统一设备清单；面向模型或 GUI 的消费方另包演进。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`phone-environment/`](phone-environment/README.zh.md) | Host 工具链探测与可信托管 mobilecli 准备 | `ctx.phoneEnvironment` |
| [`phone-environment-android/`](phone-environment-android/README.zh.md) | Android SDK、API 35 镜像与默认 AVD 准备提供方 | 注册到 `ctx.phoneEnvironment` |
| [`phone-runtime/`](phone-runtime/README.zh.md) | mobilecli 提供方与服务定义（折叠） | `ctx.phoneDevices` |
| [`phone-stream/`](phone-stream/README.zh.md) | 同源 IO WebSocket 与签名 MJPEG/H264 反代 | `ctx.phoneStream` |
| [`tool-phone/`](tool-phone/README.zh.md) | 面向模型的延迟消费方 | 注册到 `ctx.tools` |

子系统参考：[docs/subsystems/phone-runtime.zh.md](../../docs/subsystems/phone-runtime.zh.md)。
