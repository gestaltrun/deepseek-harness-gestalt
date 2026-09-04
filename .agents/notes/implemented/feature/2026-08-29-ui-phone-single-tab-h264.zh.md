# Agent Note: ui-phone 单 tab 就地切换、仅列在线设备、H264 优先采集

Status: implemented

[English](2026-08-29-ui-phone-single-tab-h264.md) | 中文

## Problem

Issue #417 后续用户验收推翻了[已连接多 tab 笔记](2026-08-28-ui-phone-connected-device-tabs.zh.md)锁定的三项客户端决定：打开第二台设备会铸造第二个 tab、切换下拉列出离线与未授权行、实时画面请求 MJPEG 而 H264 徽标保持禁用。产品现在要求：一个「手机」tab 就地切换、下拉只列在线设备，并以 H264 为首选采集格式；H264 无法绘制画面时在同 session 内用 MJPEG 恢复。

## Decision

`phone` descriptor 为 `single: true`。「打开」与设备下拉对占用中的 tab 调用 `updateTab`，把 `meta` 写成 `{ kind: 'device', serial, name }`，标题写成 `手机·<name>`。不再铸造 `phone:<serial>`，没有 serial `dedupeKey`，也没有 `createTab` 路径。`PhoneConnectedView` 上 serial 变化会销毁上一份 `PhoneConnectionController`，并为新设备铸造会话。`ui-phone.enabled` 关闭时仍然拒绝切换。

切换下拉只列 `online` 设备。离线行从下拉与空态清单一并省略。未授权真机仍走空态警示臂（「真机未授权调试」+「重新检测」），从不进入下拉。

「手机设备」清单为每个在线设备行提供一个「打开面板」操作。浏览器 renderer 直接打开单例「手机」tab。Desktop 设置运行于隔离的 overlay renderer，因此通过既有 overlay 回复协议发送有界选择；Session Surface 读取本次选择独享的 Host 权威清单、等待持久设置 gate 稳定、重新确认设备在线，再打开单例 tab 并展开面板。后到选择或 renderer 销毁会取消较早的请求与 gate 等待，且旧请求不能覆盖共享清单。

`POST /phone/session` 发送 `{ deviceId, format: 'avc' }`。live 阶段经[WebCodecs canvas 播放模块](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)加载签名的 `h264` URL；H264 无法绘制画面时切换到同 session 的签名 MJPEG URL。devbar 显示实际编码；H264 保留 `30 fps` 设计文案。

## Alternatives considered

**保留每设备一 tab，再加「替换当前」选项。** 拒绝：验收直接改定轴 1——单 tab、就地占用。

**只藏下拉、空态仍列离线行。** 拒绝：「不展示不可用设备」同样约束清单；未授权警示臂是点名保留的例外。

**以 MJPEG 作为首选格式。** 拒绝：实时画面优先请求 H264（`avc`），客户端经 WebCodecs 解码其裸 Annex-B access unit；只有该 renderer 无法绘制画面时才用 MJPEG 恢复。

## Consequences

多设备监视不再等于并行 tab：切换会替换占用设备及其流。布局不再恢复 `phone:<serial>` id；恢复得到的是单例 `phone` id 加上设备 meta。空态清单不再出现「离线 / 已停止」行。格式徽标标明当前 H264 或 MJPEG renderer。设置清单与 tab 内选择器会汇入同一个单例 tab，且不信任陈旧的 overlay 清单。[已连接多 tab 笔记](2026-08-28-ui-phone-connected-device-tabs.zh.md)继续拥有控制器、网关与错误臂决策，并记录这次对 tab 模型与采集格式的改定；[H264 播放笔记](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)拥有客户端解码与 canvas 资源生命周期。
