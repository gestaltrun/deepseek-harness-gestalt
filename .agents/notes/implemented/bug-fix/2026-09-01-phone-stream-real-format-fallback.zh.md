# Agent Note: 手机设备去重与真实采集格式回退

Status: implemented

[English](2026-09-01-phone-stream-real-format-fallback.md) | 中文

## 问题

mobilecli 1.0.5 可能重复报告同一台物理手机，也可能接受 AVC 采集请求却不产出 AVC 画面。直接诊断区分了三种失败。iOS Simulator 以 `avc format is not supported on iOS simulators` 拒绝请求。Android 真机由 DeviceKit `AvcServer` 返回 HTTP 200 `video/h264` 与 `Error 0x80001001`；设备 logcat 确认失败配置是 Qualcomm AVC encoder 拒绝输入颜色格式 `0x7f000789`，但同一设备的原生 `screenrecord --output-format=h264` 能产出有效 Annex-B；其 DeviceKit MJPEG 路径也可能无法创建 virtual display。iOS 真机可能报告 test runner 已安装，但因 DeviceKit 主应用缺失而以零字节结束 AVC。把 HTTP 状态或 session 铸造当成画面就绪，会同时留下重复设备行与空白 H264-only 视图。

## 决策

phone runtime 会验证每一条 `devices.list` 记录，再为每个 `(platform, id)` 组合保留首行。由于每个 operation 只接受 `deviceId`，同一 id 出现在两个平台时会以 `PHONE_PROTOCOL` 失败，不会投影成无法区分的目标。同平台重复项不会进入设置、手机 picker、已连接下拉框或在线 badge。

Host 把 H264 标为 Android 设备与 iOS 真机的首选格式。iOS Simulator 这个 mobilecli 设备类别会明确拒绝 AVC，因此 Host 把 MJPEG 标为其首选格式。Android H264 到达 renderer 前，runtime 会有界识别 SPS/PPS/IDR 前缀。无效或探测超时的 mobilecli AVC 先切到 Android 系统 `screenrecord --output-format=h264`；两条 H264 源都失败后才进入 renderer 的同 session MJPEG 策略。live IDR 的 slice header 完整后即可接纳，无需等待画面运动产生下一个 NAL 分隔符。devbar 只显示 live 编码，不展示 fallback 原因。Android 与 iOS 真机 session 都托管设备 agent 恢复；Android io 被拒绝后会检查 agent 并提供一键安装，OEM 要求的 USB 安装或调试安全确认仍在手机上完成。

已连接画面在按下时捕获活动 pointer。它记录每个归一化 move，把松开位移也纳入拖动阈值判定，并把起点与松开交给[精确旋转输入笔记](2026-09-04-ios-semantic-input-rotation.zh.md)拥有的语义 swipe 路径。合并后的触控板滚动沿纵轴发送同一条 swipe。完成或取消时释放捕获。隐藏 tab、更换设备/controller 或替换 live stream 也会释放并丢弃待发路径。取消与生命周期替换都不发送不完整 swipe。

## 验证

包测试固定 `(platform, id)` 去重、首行选择、跨平台歧义拒绝、设备类别首选格式、无需再次铸造或换 socket 的同 session 回退、陈旧回调拒绝、MJPEG natural 尺寸触控映射、语义 swipe 转发与精确旋转投影、合并后的滚轮 swipe、取消，以及只在 MJPEG 失败后重试。built Desktop fixture 覆盖重复清单输入、H264 HTTP 200 错误正文随后出现可见 390×844 MJPEG、另一台设备成功显示 390×844 H264、精确触控与 Home io，以及完整的进程、端口和临时根目录 teardown。fixture 仅是自动化证据；用户验收仍需在真实 Android 手机、iOS 真机与 iOS Simulator 上看到 live 画面并完成控制。

## Alternatives considered

**在 iOS Simulator 上先尝试 H264，再考虑其他格式。** 拒绝：mobilecli 会对该设备类别明确拒绝 AVC，因此该请求无法产出证据，只会延迟可用流。

**所有设备一开始都使用 MJPEG。** 拒绝：mobilecli 能产出有效 AVC 时，H264 仍是优先的高效路径；built Desktop lane 也保留一台 H264 成功设备。

**由每个 GUI consumer 分别去重。** 拒绝：设置、picker、badge、工具与后续 consumer 都要重复同一修复，而且可能产生不同结果。`devices.list` wire parser 是首个同时拥有 platform 与 id 的受控位置。

## 后果

同一连接 session 内的可见编码可能是 H264 或 MJPEG，renderer 必须从当前 live 阶段派生格式标签与触控尺寸。Android 与 iOS 真机保留 H264-first 行为。iOS Simulator 不再支付已知必败的 AVC 请求。有效 H264 路径不会请求 MJPEG；H264 失败会先支付一次同 session MJPEG 请求，再考虑重连；双格式都失败时仍进入既有有界失败臂。本记录取代[单 tab 采集记录](../feature/2026-08-29-ui-phone-single-tab-h264.zh.md)与[WebCodecs 播放记录](2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)中的 H264-only 与禁止回退决策；其中的单 tab、仅列在线设备、parser、decoder 与资源生命周期决策仍有效。
