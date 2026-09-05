# Agent Note: Android 采集源 IO 的无密钥 Host 金标

Status: implemented

[English](2026-09-05-android-capture-wire-golden.md) | 中文

## Problem

Android 采集源点击仍停留在解码平面，而 `dumpsys display` 的 `logicalFrame` 可以是该平面的均匀上采样。包内单元测试可以钉住 `upstreamIo()` 的算术，但不会启动组装后的 Host：Loader、`phone-runtime`、`phone-stream`、签名采集 GET 与 `/phone/ws/io`。deferred-phone 会话快照只把 `device_act` 当作 `{ kind: 'fresh-probe' }` 打到会丢弃请求的假设备群，因此无法拒绝错误平面的浏览器点击。

## Decision

`examples/phone-capture-wire` 是已声明的 `pnpm run test:snapshot` 场景。source 模式经 tsx 启动 `@deepseek-ai/dsh-phone-capture-wire-demo` 的 `src/bin.ts`；`DSH_EXAMPLE_MODE=lib` 在无 tsx、无 tsconfig paths 的纯 Node 下启动该包的 `lib/bin.js`。`pnpm run build` 从 `src/bin.ts` 重新生成 `lib/bin.js`；该产物被 gitignore。两个入口都通过 `dsh-app-boot` 启动同一份 `cordis.yml`：`host-webserver`、测试专用的 staged `PhoneDevices`（指向 fakemobilecli）以及 `phone-stream`。快照把合成 `adb` 与 Annex-B 字节写入自有临时 `ANDROID_SDK_ROOT/platform-tools` 并把该目录前置到 PATH，因此 dumpsys 与 screenrecord 不会启动设备 SDK 二进制。场景插件签发会话、读取 `GET /phone/devices` 并要求 `logicalDisplay` 为 `2248×1080`、保持签名 H264 GET 打开，然后在同一 grant 上发送两次带 `captureRotation: 0` 的 JSON-RPC tap。stdout 只投影签发 `captureId`、采集 `token` 与 `expiresAt`；JSON-RPC 错误码与消息保持字面量，因此缺 bounds 的失败无法匹配宽高比不匹配的金标。数值平面与 fakemobilecli 的 `device.io.*` 行保持字面量。IO WebSocket 的 open 与 reply 有界，并在每条路径上移除 listener。

在尚未具备 Host 采集到逻辑坐标映射的功能 SHA 上，错误平面臂会被接受并以上游未缩放坐标转发，兼容下采样也会未缩放转发；已提交金标记录映射后的契约，在该映射落地前为红。`examples/headless-agent/tests/deferred-phone-tools.snapshot.ts` 仍是模型 / fresh-probe 兼容场景，不加长。

## Alternatives considered

**加长 deferred-phone 会话 JSONL。** 拒绝：该 overlay 从不发送 `kind: 'capture'`，也不启动 `phone-stream`。

**把 `routes.spec.ts` 里对 dumpsys 的进程内 `vi.mock` 当作组装门禁。** 拒绝：该门禁必须是已声明的 Loader 快照，而不是私有单元 mock。

**对端口、token 与协议消息使用宽泛快照归一化。** 拒绝：只投影签发身份字段；JSON-RPC 错误文本与映射坐标保持字面量，因此缺 bounds 的失败无法匹配宽高比不匹配的金标。

**等后端冻结后再写场景。** 对本测试切片拒绝：该金标是独立 seam，在当前功能树上保持红色，直到映射合入。

## Consequences

Host 采集线拥有无密钥的组装拒绝与映射判定。贡献者只跑一个快照文件；fakemobilecli 与合成 `adb` 由该进程持有，并在每种结果下释放。真机、Simulator、WDIO 与模型密钥不进入本车道。
