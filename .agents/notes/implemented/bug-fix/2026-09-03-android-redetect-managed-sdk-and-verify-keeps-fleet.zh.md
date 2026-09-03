# Agent Note: Android redetect keeps the managed SDK; verify failure keeps the fleet

Status: implemented

[English](2026-09-03-android-redetect-managed-sdk-and-verify-keeps-fleet.md) | 中文

## Problem

Android 准备成功后再点「重新检测」会把 SDK 报成缺失。`AndroidEnvironmentManager` 的发现逻辑只查询 `ANDROID_HOME`、`ANDROID_SDK_ROOT`、Host 默认位置和 `PATH` 中的 `sdkmanager` 条目，从不探测私有托管根目录 `$DSH_HOME/phone/android/sdk`，因此它自己装好的 SDK 对重新检测不可见。

Android 运行时验证失败会通过 `ctx.phoneDevices.deactivate()` 停掉整个 mobilecli fleet。验证失败是设备级状况，但这种拆除把健康的运行时一并停掉，设置卡片随后对仍然就绪的 fleet 渲染「未找到 mobilecli」。单一的 15 秒 `ANDROID_RUNTIME_VERIFY_MS` 同时覆盖在线清单检查和 H264 探测，因此 mobilecli 还没来得及把冷启动的模拟器列为在线时，验证就在画面探测运行之前失败了。

## Decision

当环境变量与 `PATH` 发现未命中时，`refresh` 从磁盘探测托管根目录：计划报告 `sdkSource: 'managed'`，组件状态读自磁盘，因此重新检测已准备好的安装会保持 `ready` 且 `running: false`。Host 托管的 SDK 无需兼容性重复探测，因为准备流程固定的正是这套工具链。

`activateAndroidRuntime` 失败只通过 `this.android.deactivate()` 停止 Android 提供方持有的模拟器；已激活的 fleet 保持就绪，运行时快照保持 `kind: 'ready'`。`verifyAndroidRuntime` 拆分预算：有界在线清单等待在可配置的 `androidRuntimeVerifyTimeoutMs` 上限（默认 180000 毫秒）内每秒轮询 `listDevices`，通过后才 `startCapture`；可识别画面探测保留 15 秒 `ANDROID_RUNTIME_VERIFY_MS` 预算与 4 MB 字节上限。

设置卡片的清单来源接收一个读取 Host 运行时快照的 `runtimeReady` 接口：`PHONE_UNRESOLVED` 的 fleet 拉取只在运行时未就绪时渲染 mobilecli-missing 行；运行时就绪时该拉取落到平台中立的「无设备」恢复行，因为就绪快照证明 fleet 处于活动状态，该解析失败是陈旧信息。

## Alternatives considered

**每次重新检测未命中都重新准备 SDK。** 否决：托管根目录就在磁盘上且完整；为弥补发现缺口而重新下载固定工具链是自找的抖动。

**Android 验证失败时继续停掉 fleet。** 否决：失败指向的是设备而非 mobilecli；停掉 fleet 惩罚了健康的运行时，并渲染出错误的 mobilecli-missing 行。

**把单一验证预算拉长到 15 秒以上。** 否决：那会把冷启动清单波动耦合进 H264 画面探测，而后者在设备在线后只需要短预算。

**把任何 `PHONE_UNRESOLVED` 拉取都当作 mobilecli-missing。** 否决：运行时快照就绪时 fleet 可证明是活动的，该行会引导用户重新准备一套本已可用的安装。

## Consequences

对托管 SDK 的重新检测是幂等的，一次失败的就绪提交只损失模拟器而非 fleet。冷启动最多有三分钟时间出现在清单中；始终不上线的设备仍以 `PHONE_ANDROID_RUNTIME_VERIFY` 失败，只是上限现在可由运维调节。测试固定了托管根目录重新检测、保留 fleet 的验证失败、假定时器下「先在线后 H264」的顺序，以及运行时就绪时 `PHONE_UNRESOLVED` 的回退行为。
