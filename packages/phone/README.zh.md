# phone/ — 手机设备群能力族

[English](README.md) | 中文

以外部 mobilecli 为后端的手机设备群：一个 Host 半区 Service 负责回环服务子进程、健康轮询与统一设备清单；面向模型或 GUI 的 Consumer 另包演进。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`phone-runtime/`](phone-runtime/README.zh.md) | mobilecli Provider 与 Service Definition（折叠） | `ctx.phoneDevices` |
| [`tool-phone/`](tool-phone/README.zh.md) | 面向模型的延迟 Consumer | 注册到 `ctx.tools` |

子系统参考：[docs/subsystems/phone-runtime.zh.md](../../docs/subsystems/phone-runtime.zh.md)。
