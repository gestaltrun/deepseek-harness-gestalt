# Agent Note: Host 存活期内的 phone runtime occupancy pool

Status: implemented

[English](2026-09-06-phone-runtime-pool-occupancy.md) | 中文

## 问题

`PhoneDevices` 只拥有一代 mobilecli（`serverPort`、一个子进程）。#574 需要一个共享的 external generation 加上 N 个隔离 iOS generation，且不得引入 Session/设备产品租约。共享 generation 的 stub 会把第一次 适配器 start 复用给后续 acquire，隔离清单、采集与释放无法独立。

## 决定

`packages/phone/phone-runtime/src/runtime-pool.ts` 是内部 external occupancy 核心。每次 `acquireExternal` 铸造新的 `PhoneRuntimeOccupancyId` 与 句柄。两次 external acquire 共享一个 Host 生命周期 slot 与一代 generation。`acquireIsolatedIos` 保留在类型上，在私有 HOME/模拟器 set/监听绑定提供者存在之前拒绝 `PHONE_UNAVAILABLE`；绝不回退到 external generation。`PhoneRuntimeGeneration` 没有 dispose（资源释放）。调用方释放只能 `handle.release()`，且只丢掉该 occupancy。池保存 适配器 返回的、绑定该子进程的 `stop`。abort/replace/dispose 之后迟到的 start 调用**该** `stop`，不安装。Replace 提升 epoch；旧 句柄 拒绝 `PHONE_ABORTED`，不得停止新子进程。`stopExternal` 保留 occupancy、去掉 generation、操作拒绝 `PHONE_UNRESOLVED`、epoch 不变、不自动启动。下一次 start（`replaceExternal` 或 `acquireExternal`）提升 epoch 并作废那些 id；调用方必须重新 acquire。适配器 `start` 接收每 slot 的 `config.provenance`（`host-external` | `host-isolated-ios`）以及可选可执行文件/环境——绝不是 Session id。Dispose/最后一次 release 用配置的 `cleanupTimeoutMs` 与 start/stop 竞速。dispose Promise 在该预算后结束。`closed` 表示停止接纳，不是工作已完成。`cleanupPending` 覆盖尚未返回的 适配器 start 以及迟到的实例 `stop`。已结算 Promise 之后的迟到 `stop`/`start` 失败保留在 `lifecycle().cleanupFailures`，不得变成未处理拒绝。

本子集**不**抽取现有 `PhoneDevices`、**不**分配监听端口、**不**证明 Host SIGKILL 收容。#574 仍开放。

## 考虑过的替代方案

**External join 共用同一 句柄 再 refcount。** 否决：第一次 `release` 会丢掉所有加入者。

**适配器 `stop(slot)`。** 否决：迟到的旧 start 会杀掉替换代。

**用 N 个 Cordis `PhoneDevices` 当产品池。** 否决：两个 generation 所有者。

**Host dispose 时无上限等待 适配器 start。** 否决：忽略 `signal` 的 适配器 会卡住 Host 拆除。

## 后果

Host 存活期内的 external occupancy 核心支持兄弟取消、失败 start 清理与有界 dispose。假适配器验证这些义务；使用 `stageFake` 的两个独立 external 池验证独立 generation，而不是同一池内的隔离 generation。在私有提供者存在之前，隔离功能仍不可用。Host 死亡后的后代成员关系、有界 loopback 端口分配、以及把 `PhoneDevices` 迁到该适配器，仍未交付。

## 测试

`runtime-pool.spec.ts` 覆盖互异 external 句柄、兄弟取消立即 `PHONE_ABORTED` 且不等待 start、失败 start 后重试、dispose 接纳 `closed` 且 `cleanupPending` 覆盖未完成 start 与迟到 `stop`、迟到清理失败记入 `lifecycle().cleanupFailures`、replace 作废、`stopExternal` 不自动启动、memoize dispose、last-release/dispose 清理预算、彼此独立的 stop 失败、isolated `PHONE_UNAVAILABLE`，以及两个 fake external generation 且无静默回退。

## 相关

舰队 Service 所有权仍由 [mobilecli provider 笔记](../feature/2026-08-27-phone-runtime-mobilecli-provider.zh.md) 持有。缺二进制时的组合仍由 [未解析二进制笔记](../bug-fix/2026-08-30-phone-runtime-unresolved-mobilecli.zh.md) 持有。
