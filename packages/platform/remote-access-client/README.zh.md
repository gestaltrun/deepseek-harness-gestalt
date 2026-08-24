# 远程访问客户端

[English](README.md) | 中文

面向公开远程访问服务的 Desktop 与 Mobile 鉴权 HTTP 传输。每次操作转发一份当前安装的账号证明，并在暴露带品牌的个人配对标识符前校验所有 JSON 响应。`QUOTA` 与 `PLATFORM_CAPACITY` 会把整数秒 `retryAfter` 保留在抛出的 `RemoteAccessError` 上。

HTTP 客户端不实现握手，也不存储配对密钥。产品控制器提供已登录账号的鉴权信息，端点持有的 Snow owner 通过 Platform mailbox 交换不透明握手消息。确认后，Mobile pairing controller 通过密码 adapter 打开封装的 endpoint 专属 Relay authority，并配置 `MobileRelayEndpointLifecycle`；该生命周期可在存活附着上发送，`unpair()` 会调用 `configure(undefined)`，因此该生命周期不再持有 authority。控制器不会收到 Desktop credential。

`RemoteRelayEndpointController` 通过部署的单个 non-sticky Platform endpoint，拥有一条出站 Mobile 或 Desktop WSS 生命周期。每条物理连接都取得新的 attachment id，以公开 SPKI 请求绑定完整元组的挑战，再用可轮换的端点私有 P-256 密钥签名。控制器会等待匹配的 Platform ready acknowledgement，再执行 resync；它为该 attachment generation 发布受抑制的 `onConnectionReady` 与 `onConnectionLost` observation，并把物理 lifecycle 的 abort signal 交给入站 ciphertext owner。Desktop grant 替换会在停止 controller 前使对应 pairing callback 失效；stop 会在排空 socket 前中止 pending callback。Desktop projection owner 可以重连一个 pairing 而不淘汰其持久 grant；串行转移会先停止旧 physical attachment，再启动其替换。socket 丢失后会在已校验的重试延迟后建立新连接；Desktop 在每次 attachment 后发送权威加密 resync。transport-error observer 会完整接收可识别的 Relay 容量错误和 Encrypted Companion 协议错误，包括稳定 code、重试延迟或必须升级的 endpoint；只有未分类的连接失败会变成 `REMOTE_OFFLINE`，observer 自身失败也不能中断重连。断开期间发送会以 `REMOTE_OFFLINE` 失败，且绝不保留或重放。

浏览器与 Node adapter 会在物理 socket 上执行 Relay wire 上限，并把消息送入同时限制 item 数与字节数的在线 queue。消费者阻塞或入站 frame 超限时会关闭 socket，而不是累积无 owner 的密文。接收的密文必须指向当前 route 与目标 attachment，endpoint callback 才能观察它。

Desktop 设置所有者只在手机访问开启期间启动该生命周期。关闭窗口会退出 Desktop 进程；sleep、quit、退出账号或关闭手机访问都会停止并排空 socket。不存在 daemon、后台 Host 或 remote wake 路径。

## 模型体验

无。远程访问传输值不会进入模型请求。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 产品组合提供已校验的 WSS URL、重试与 heartbeat 间隔和在线 queue 限制；本包拥有 Node 与浏览器 adapter、生命周期和编码后的 Relay frame。
- 生产使用仍要求 Platform 部署组装经过评审的握手提供方。
