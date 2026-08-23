# language: zh-CN
@local-companion
功能: 附件、审批、Ask User 与缓存
  作为已配对的 Mobile
  我希望图片、审批、Ask User 与离线缓存都走 Desktop 权威
  以便 Relay 看不到明文，通知不能直接结算

  @live
  场景: 发送加密附件
    假如 作曲器提供选图或选文件
    当 Mobile 封装明文并发送 offer-attachment
    那么 Desktop 对未过期 capability 确认
    而且 图片文件名投影为 image 块
    而且 非图片文件名投影为 Attached: 文本
    # 开发路径不把附件明文字节放进 Relay；过期 capability 返回 attachment-rejected

  @live
  场景: 结算 Desktop 授权的审批
    假如 Desktop 在 prompt 完成后投影了 approval 块且 companionMayMutate
    当 Mobile 点击允许
    那么 结算通过 Encrypted Companion settle-approval 发回 Desktop
    而且 仅在 Desktop 接受后卡片变为已结算
    而且 通知栏动作不能结算

  @live
  场景: 回答 Ask User
    假如 Desktop 在 prompt 完成后投影了 ask-user 块且 companionMayMutate
    当 Mobile 选择一个 Desktop 已授权的答案
    那么 答案通过 answer-ask-user 发回 Desktop 并等待确认
    而且 过期或未同步时不改本地 settled

  @live
  场景: 离线只读 Companion Cache
    假如 曾经打开过 Desktop 确认的 Session
    当 Desktop 变为 Remote Offline
    那么 Mobile 仍可阅读已缓存的元数据与打开过的 transcript
    而且 不能排队提示、取消、审批或其他 mutation
    而且 附件、终端、spill、凭据字节不进缓存

  @blocked
  场景: 内容无关推送唤醒审批或提问
    假如 APNs 或 FCM 投递 category 为 approval 或 question 的 hint
    当 用户点开通知
    那么 Mobile 先前台重连并 Desktop 同步
    然后 才展示交互详情
    # 阻塞: 无原生工程，无 APNs/FCM，TestFlight/APK 未授权

  @blocked
  场景: 模拟器或真机打开原生 Gestalt Mobile App
    假如 已生成 Capacitor ios 与 android 工程
    当 在模拟器安装并启动 App
    那么 主屏图标打开的是 App 而不是 Vite 网页
    # 阻塞: 仓库无 capacitor.config、ios/、android/；#44 的 TestFlight/签名 APK 未授权
