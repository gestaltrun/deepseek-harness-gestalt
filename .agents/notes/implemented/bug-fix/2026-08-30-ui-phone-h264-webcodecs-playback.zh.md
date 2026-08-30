# Agent Note: 用 WebCodecs 解码 ui-phone H264 流

Status: implemented

[English](2026-08-30-ui-phone-h264-webcodecs-playback.md) | 中文

## 问题

`phone-stream` Host 路由返回裸 Annex-B H264 基本流。把签名 URL 交给 `<img>` 无法在 Chromium 中得到解码画面：传输可以返回 HTTP 200、`video/h264` 与有效字节，但元素仍为 0×0，并让已连接视图进入 interrupted 臂。客户端必须先得到可见帧，现有归一化指针坐标才能映射到设备像素。

## 决策

`PhoneH264Surface` 是 `PhoneConnectedView` 内的 canvas 适配器。其接口包含签名 URL、canvas 样式与可访问名称、解码画面尺寸回调、失败回调，以及由 connected view 保留的播放 owner。该 owner 跨越非 live 阶段，在上一份句柄 settlement 后才启动 replacement，并阻止已过时的排队 replacement 启动。

`playPhoneH264Stream` 在单个异步 `close()` 操作后拥有浏览器播放实现。它拉取签名同源 URL，要求成功的 `video/h264` 应答，增量识别三字节与四字节 Annex-B 起始码，根据 AUD 或 SPS、PPS 与 slice header 中的 AVC picture-identity 字段解析未使用 data partition 的 primary coded picture，从 SPS 推导完整 AVC codec 字符串，并把每幅 picture 作为一个 `EncodedVideoChunk` 送入 `VideoDecoder`。同一 identity 的多个 slice 保持在一幅 picture；缺失首个 macroblock 的 picture、首 slice 之后改变 identity 以及 2–4 型 data-partition NAL 都会显式失败。parser 接受 chroma format 0–2、POC type 0 或 2 的 progressive picture；interlaced picture、scaling matrix、bottom-field picture-order signaling、chroma format 3 与 POC type 1 会在进入 decoder 前失败。decoder 队列产生背压时等待 `dequeue` 事件；`flush()` 只用于有限流 EOF，之后不会再接收 delta chunk。每个输出 `VideoFrame` 都在同一回调中绘制到 canvas 并关闭；其显示宽高会更新 canvas 与 `PhoneConnectionController` 的触控面。

句柄拥有 `AbortController`、应答 reader、decoder、输出帧和失败投递。设备切换、刷新、tab inactive、重连与卸载会先同步禁止后续发布；不会 reject 的 `close()` promise 在 reader 取消且解码 run 停止后完成，陈旧回调只关闭帧而不绘制。consumer callback 的异常会在 cleanup 武装后被收容。拉取、解析、支持性检查、decoder 与 canvas 失败只经 `noteCaptureFailure()` 报告一次，并进入现有有界重连策略。每次 controller teardown 都会清空已学习的触控面，因此下一条 live socket 会在新播放画出首帧前拒绝 tap。有限应答只要绘制过至少一帧，就会保留最后一幅 canvas 画面并释放 decoder；空应答属于播放失败。

## 验证

包测试覆盖网络分片切点、三字节与四字节起始码、无 AUD 的 picture identity、AUD 与 parameter set 排序、多 slice access unit、拒绝中途改变 identity/data-partitioned 流、SPS 推导的 codec 输入、IDR-to-delta 队列背压、不支持与畸形输入、尺寸变化、精确 390×844 触控映射、静止态取消、跨非 live 阶段的三代设备 replacement、decoder 失败、consumer callback 收容、陈旧回调和帧关闭。loopback Electron 41.2.1 probe 把 fakemobilecli 的 1,534,614 字节 Annex-B fixture 解码为三幅 390×844 `VideoFrame`，并绘制到 390×844 canvas。

## Alternatives considered

**退回 MJPEG。** 拒绝：已验收的产品格式是 H264-only；fallback 会让可见徽标与传输行为不一致。

**封装进 MSE 或添加 codec 依赖。** 拒绝：Desktop Host 的 loopback Chromium 可通过 WebCodecs 支持 fixture 的 AVC profile，流中没有需要保留的音频或容器时间线，而且平台播放比依赖更能删除自有封装代码。

**把解析与 decoder effect 放进 `PhoneConnectedView`。** 拒绝：React 将因此拥有 fetch 分片、access-unit 状态、背压、帧释放与取消顺序。播放模块把这些实现收敛在一个句柄后，视图仍只镜像连接阶段。

## 后果

已连接视图保持 H264-only，且不增加 npm 依赖。它要求支持 WebCodecs AVC 的安全上下文浏览器；不支持的运行时进入普通 interrupted/重连臂，不会静默尝试另一种格式。解码后的显示尺寸仍是设备 tap 与 gesture 坐标的权威值，CSS 与容器尺寸不是。
