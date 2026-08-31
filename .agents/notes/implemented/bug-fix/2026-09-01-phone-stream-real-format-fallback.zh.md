# Agent Note: 手机设备去重与真实采集格式回退

Status: implemented

[English](2026-09-01-phone-stream-real-format-fallback.md) | 中文

## 问题

mobilecli 1.0.5 可能重复报告同一台物理手机，也可能接受 AVC 采集请求却不产出 AVC 画面。已观察的 Android 输出返回 HTTP 200 `video/h264` 与错误正文，已观察的 iOS 真机输出以零字节结束，iOS Simulator 则拒绝 AVC；这三类设备都能产出 MJPEG 帧。把 HTTP 状态或 session 铸造当成画面就绪，会同时留下重复设备行与空白 H264-only 视图。

## 决策

phone runtime 会验证每一条 `devices.list` 记录，再为每个 `(platform, id)` 组合保留首行。由于每个 operation 只接受 `deviceId`，同一 id 出现在两个平台时会以 `PHONE_PROTOCOL` 失败，不会投影成无法区分的目标。同平台重复项不会进入设置、手机 picker、已连接下拉框或在线 badge。

`PhoneConnectionController` 对每份已铸造 session 先启动 H264。H264 拉取、协议、解析、浏览器支持、解码、绘制或零帧结束中的任一失败都会清空已学习的触控面，并把 live 阶段切换到同一 session 的签名 MJPEG URL，不关闭或替换其 io socket。devbar 显示 live 阶段的实际编码。MJPEG 元素把 `naturalWidth` 与 `naturalHeight` 发布为触控坐标面；已被替换的 H264 renderer 回调不能覆盖它。MJPEG 失败后才关闭当前资源并进入既有三次有界重连策略。

## 验证

包测试固定 `(platform, id)` 去重、首行选择、跨平台歧义拒绝、无需再次铸造或换 socket 的同 session 回退、陈旧回调拒绝、MJPEG natural 尺寸触控映射，以及只在 MJPEG 失败后重试。built Desktop fixture 覆盖重复清单输入、H264 HTTP 200 错误正文随后出现可见 390×844 MJPEG、另一台设备成功显示 390×844 H264、精确触控与 Home io，以及完整的进程、端口和临时根目录 teardown。fixture 仅是自动化证据；用户验收仍需在真实 Android 手机、iOS 真机与 iOS Simulator 上看到 live 画面并完成控制。

## Alternatives considered

**更换 session 后重试 H264，再考虑其他格式。** 拒绝：已观察的失败属于设备类别的 codec 限制；再次铸造只会重复同一条不支持的请求，并打断正常工作的 io socket。

**所有设备一开始都使用 MJPEG。** 拒绝：mobilecli 能产出有效 AVC 时，H264 仍是优先的高效路径；built Desktop lane 也保留一台 H264 成功设备。

**由每个 GUI consumer 分别去重。** 拒绝：设置、picker、badge、工具与后续 consumer 都要重复同一修复，而且可能产生不同结果。`devices.list` wire parser 是首个同时拥有 platform 与 id 的受控位置。

## 后果

同一连接 session 内的可见编码可能是 H264 或 MJPEG，renderer 必须从当前 live 阶段派生格式标签与触控尺寸。有效 H264 路径不会请求 MJPEG；H264 失败会先支付一次同 session MJPEG 请求，再考虑重连；双格式都失败时仍进入既有有界失败臂。本记录取代[单 tab 采集记录](../feature/2026-08-29-ui-phone-single-tab-h264.zh.md)与[WebCodecs 播放记录](2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)中的 H264-only 与禁止回退决策；其中的单 tab、仅列在线设备、parser、decoder 与资源生命周期决策仍有效。
