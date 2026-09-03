# @deepseek-ai/dsh-phone-environment

[English](README.md) | 中文

Host 在 `ctx.phoneEnvironment` 上持有手机工具链状态。该 Service 为「手机设备」设置客户端发布一份不可变全量快照，并在启用开关或活动 mobilecli generation 变化时保持自身身份。共享运行时状态是 missing / downloading / verifying / activating / ready / failed 闭合联合。Android 与 iOS 准备使用各自可扩展状态；非 macOS Host 将 iOS 报告为不支持，不提供无法执行的操作。

托管运行时固定到 mobile-next/mobilecli 官方 GitHub Release 的六个 1.0.5 归档，覆盖 macOS、Windows 与 Linux 的 arm64 和 amd64。包清单记录每个固定 URL、字节长度、SHA-256 摘要与归档内可执行文件名。准备只跟随官方 GitHub asset redirect，把数据流式写入 owner-only staging 目录，校验长度与 SHA-256，只接受 zip 根目录中的单个可执行文件，探测 `mobilecli --version`，最后原子替换 `current.json`。失败或取消会删除 staging，并保留此前 current generation 可用。运行时选择顺序为显式运维 override、托管 current、系统发现。它绝不写入全局 npm 安装或 `PATH`。

Host 通过共享同源信任栅栏，在 `GET /phone/environment` 提供全量快照，并在该路径下提供 `prepare`、`cancel` 与 `refresh` POST 操作。Desktop 每次启动都会组合此 Service、`phone-runtime`、`phone-stream` 与 `tool-phone`。稳定 fleet 会等待本 Service 选择可执行文件；启用会就地激活，关闭则取消准备并停止所持有的 child。

mobilecli 使用 FSL-1.1，并带 Apache-2.0 future license。运行时从上游 Release 直连下载不等于把副本放进 Desktop Bundle，但在法务或上游许可方确认预期产品用途获准之前，产品发布仍被阻塞。本包不 vendor 或再分发 mobilecli。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | `$DSH_HOME/phone` | 私有托管安装根目录，包含 staging 目录、不可变版本与 `current.json`。 |
| `executablePath` | — | 运维方持有的可执行文件 override。其优先级始终高于托管和系统 candidate；配置期间托管准备以 `PHONE_ENVIRONMENT_OVERRIDE` 拒绝。 |

并发准备以 `PHONE_ENVIRONMENT_BUSY` 拒绝，取消使用 `PHONE_ENVIRONMENT_ABORTED`。下载信任失败使用 `PHONE_ENVIRONMENT_DOWNLOAD`、`PHONE_ENVIRONMENT_LENGTH` 或 `PHONE_ENVIRONMENT_DIGEST`；归档、版本、current 指针与文件系统失败使用 `PHONE_ENVIRONMENT_ARCHIVE`、`PHONE_ENVIRONMENT_VERSION`、`PHONE_ENVIRONMENT_CURRENT` 或 `PHONE_ENVIRONMENT_DISK`。激活与运行时意外丢失使用 `PHONE_ENVIRONMENT_ACTIVATION` 和 `PHONE_ENVIRONMENT_RUNTIME_LOST`。检测或准备失败时，Service 不会静默选择低优先级 candidate，也不会让旧 child 与工具继续活动。

## Model Experience

通过 `dsh-tool-phone` 间接影响模型；仅当启用的运行时 generation 就绪后，该 Consumer 才注册延迟 `device_*` 工具。

#### KV Cache effect

运行时缺失或关闭时无影响。只有在 `dsh-tool-phone` 下完成工具发现后，延迟手机 schema 才进入请求。

## Known Limitations and Deferred Work

- Android SDK 与模拟器准备归属平台专用 Android 环境包。
- iOS 运行时与模拟器准备归属仅 macOS 可用的 iOS 环境包。
- FSL-1.1 产品用途许可确认仍是 Desktop 发布阻塞项。
