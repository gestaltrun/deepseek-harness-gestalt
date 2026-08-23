# language: zh-CN
@local-companion
功能: Platform Account 与个人配对
  作为同一 GitHub 账号下的 Desktop 与 Mobile
  我希望先登录 Platform Account，再完成 Desktop 确认的个人配对
  以便手机只能在配对成功后使用 Companion Surface

  背景:
    假如 本地双实例 Platform 在 https://127.0.0.1:8443 监听
    而且 Mobile 页打开 http://127.0.0.1:5174
    而且 Desktop Electron 选择 DSH_PLATFORM_ENV=development 且 DSH_PERSONAL_PAIRING_KEYLESS=1

  @live @passed
  场景: Desktop 与 Mobile 用同一账号登录本地 Platform
    当 Desktop 接受隐私说明并开始登录
    而且 Mobile 勾选隐私说明并使用 GitHub 继续
    那么 两侧都显示 @octocat 与 GitHub ID 13994321
    而且 账号身份本身不授予 Desktop 或 Device Principal 权限

  @live @passed
  场景: Desktop 开启 Mobile Access 并确认一次性配对链接
    假如 Desktop 与 Mobile 已登录同一 Platform Account
    当 Desktop 开启 Mobile Access 并创建配对挑战
    而且 Mobile 粘贴完整的一次性 https 配对链接并继续配对
    而且 Desktop 确认待确认 pairing id
    那么 Mobile 显示已配对、Companion Surface 已激活、Remote Online
    而且 Desktop 设备列表出现该 Android 或 iOS 设备
    而且 配对链接仍使用 https://127.0.0.1:8443/pair 原点

  @live @passed
  场景: 无密钥 Relay 附着后 Desktop 同步使手机可变更
    假如 个人配对已确认
    当 Mobile 向 desktop-development-keyless 发送一字节同步帧
    而且 Desktop 回复一字节同步帧
    那么 Mobile 的 companionMayMutate 为真
    而且 浏览区连接标签为 Remote Online

  @blocked
  场景: 生产 Platform 完成真实 GitHub OAuth 后登录 Desktop
    假如 Desktop 选择 DSH_PLATFORM_ENV=production
    而且 生产 origin 为 https://www.gestaltrun.com
    当 用户在系统浏览器完成 GitHub Authorization Code + PKCE
    那么 Desktop Account 进入 signed-in
    而且 账号记录通过操作系统 safeStorage 持久化
    # 阻塞: 隔离 Electron 的 safeStorage.encryptString 不可用；云壳曾拦截 Node 出站

  @blocked
  场景: 生产环境拒绝无密钥配对与 Relay
    假如 生产 listen 只挂载 Account HTTP
    当 Desktop 或 Mobile 选择 production 且未提供已评审的 Noise provider
    那么 Personal Pairing 状态为 unavailable
    而且 不挂载配对 HTTP 与 Relay WSS
    # 这是产品门闩，不是缺陷；要测通配对必须用本地 development listen

  @live
  场景: 退出此安装不删除 Personal Pairing
    假如 Mobile 已配对
    当 用户点击退出此安装
    那么 Personal Pairing 记录仍在
    而且 再登录同一账号后可以恢复配对状态

  @live
  场景: 解除配对后不能再发 mutation
    假如 Mobile 已配对且 Remote Online
    当 用户解除配对
    那么 companionMayMutate 为假
    而且 之后的可见性变化不能再 start Relay socket

  @live
  场景: 第二台手机顶掉第一台
    假如 已有一台 Mobile 附着 desktop-development-keyless 与 mobile-development-keyless
    当 第二台手机用同一 keyless 附着 id 连接
    那么 第一台失去 live attachment
    # 无密钥产品共用附着 id，测试必须串行

  @observed
  场景: Desktop 配对列表 online 仍为静态 false
    假如 Desktop 与 Mobile 已配对且 Relay 已附着
    那么 配对设备列表的 online 字段可以仍是 false
    # 目录尚未从 Relay 目录更新

  @observed
  场景: Mobile 整页刷新后配对不持久
    假如 Mobile 已配对
    当 页面 ignoreCache 刷新
    那么 需要重新粘贴一次性链接完成配对

  @live
  场景: 关闭 Desktop 窗口后 Remote Offline
    假如 Mobile 已配对且 Remote Online
    当 Desktop 关闭最后窗口
    那么 Mobile 连接标签变为 Remote Offline
    而且 作曲器拒绝发送

  @live
  场景: 不同 GitHub 账号不能完成配对
    假如 Desktop 登录 octocat
    当 Mobile 用另一个 GitHub 账号打开配对链接
    那么 配对不能进入已确认状态

  @live
  场景: Android WebView 必须使用 127.0.0.1 与 adb reverse
    假如 Android 模拟器要打开 Mobile Vite 页
    当 使用 http://10.0.2.2
    那么 不是安全上下文，无法创建 Installation id
    而且 必须 adb reverse 后打开 http://127.0.0.1

  @live
  场景: iOS 隐私勾选必须页内点击
    假如 iOS Safari 打开 Mobile 页
    当 自动化勾选隐私说明
    那么 必须对复选框 el.click
    而且 不得使用 ?acceptPrivacy=1
