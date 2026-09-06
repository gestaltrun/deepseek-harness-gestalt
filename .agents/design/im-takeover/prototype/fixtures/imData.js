// IM 接管 demo fixtures（全部为示例数据；仅存内存，重置即还原）

export const PLATFORMS = {
  dingtalk: {
    name: '钉钉', cls: 'pf-ding', letter: '钉',
    demoIdentity: { name: '陈小宇', sub: '企业：示例科技' },
    authPath: '经 DWS 的本机登录态（真实用户身份）',
    flow: [
      { title: '检测本机登录', desc: '检测本机 DWS 中已登录的钉钉账号。', action: '开始检测', wait: '正在检测本机登录…', canFail: true, error: '未检测到本机已登录的钉钉账号。请完成登录后重试。' },
      { title: '确认账号身份', desc: '将以此钉钉账号的身份接管会话。', identity: true, action: '确认并完成' },
    ],
  },
  qianniu: {
    name: '千牛', cls: 'pf-qn', letter: '牛',
    demoIdentity: { name: '潮流女装旗舰店', sub: '商家账号' },
    authPath: '商家级接入凭证（真实商家身份）',
    flow: [
      { title: '接入凭证', desc: '输入商家接入凭证以建立连接。', form: true, action: '校验连接', wait: '正在校验连接…', canFail: true, error: '连接校验失败，请检查凭证后重试。' },
      { title: '确认商家身份', desc: '将以该商家的客服身份收发消息。', identity: true, action: '确认并完成' },
    ],
  },
  feishu: {
    name: '飞书', cls: 'pf-lark', letter: '飞',
    demoIdentity: { name: '陈晓', sub: '飞书企业示例' },
    authPath: 'OAuth 用户授权（真实用户身份）',
    flow: [
      { title: '授权飞书账号', desc: '前往飞书授权页，由你本人确认授权。', action: '前往授权' },
      { title: '等待授权完成', desc: '请在飞书中完成授权，然后回到本页面继续。', action: '我已完成授权', wait: '正在确认授权状态…', canFail: true, error: '授权未完成或已过期，请重试。' },
      { title: '确认账号身份', desc: '将以你本人的飞书身份收发消息。', identity: true, action: '确认并完成' },
    ],
  },
}

export const QN_EXAMPLE = { endpoint: 'https://openapi.example.internal', accessKey: 'ak-demo-0001', secretKey: 'demo-secret-placeholder' }

export const CONFLICT_MAP = { 'DSH 用户反馈群': 'Travel-Merchant-Agent-Team', '度假售后协作群': 'merchant-cs' }

export const DEFAULT_STATE = () => ({
  accounts: [
    { id: 'acc-d1', platform: 'dingtalk', name: '陈小宇', sub: '企业：示例科技', connected: true, auto: true, authState: 'ok' },
    { id: 'acc-q1', platform: 'qianniu', name: '潮流女装旗舰店', sub: '商家账号', connected: true, auto: true, authState: 'ok' },
  ],
  routes: [
    { id: 'r1', accountId: 'acc-d1', type: 'group', scope: 'specific', targets: ['度假开发联调群', 'DSH 设计评审群'], enabled: true, triggers: { mention: true, everyN: 10, intervalMin: null } },
    { id: 'r3', accountId: 'acc-d1', type: 'dm', scope: 'specific', targets: ['产品-林'], enabled: false, triggers: null },
  ],
  simConfig: { targetKey: 'qn-all-dm' },
  sim: { 'sim-0117-a': { status: 'running' }, 'sim-0117-b': { status: 'running' } },
  realPanelMsgs: null,
})

export const REAL_MSGS_SEED = [
  { side: 'in', who: '张伟', tag: 'ext', tagText: '组员', time: '09:15', html: '支付回调昨晚又超时了两次，日志我发下面了，帮忙定位下原因 <span class="mention">@数字员工</span>' },
  { side: 'in', who: '李娜', tag: 'ext', tagText: '组员', time: '09:16', quote: '张伟：支付回调昨晚又超时了两次…', html: '引用一下，这个问题昨天复盘会也提过' },
  { side: 'out', who: '数字员工', tag: 'ai', tagText: 'AI', time: '09:17', html: '收到，我先按回调重试链路排查，有结论会在群里同步。<span class="mention">@张伟</span>', status: 'delivered' },
  { side: 'out', who: '陈小宇', tag: 'self-native', tagText: '本人 · 钉钉客户端', time: '09:18', html: '补充一下：超时集中在 22:40 那一批，我这边手动重放成功了', status: 'delivered' },
  { side: 'out', who: '数字员工', tag: 'ai', tagText: 'AI', time: '09:19', html: '了解，结合 22:40 那批继续查（人工补充已由 Agent 按工作区策略纳入判断，不强制停机）', status: 'sending' },
  { side: 'out', who: '陈小宇', tag: 'unknown', tagText: '本账号 · 来源待确认', time: '09:21', html: '平台未提供足够证据区分这条是本人手发还是系统发出，按「不确定」处理，不猜测身份' },
  { side: 'in', who: '王芳', tag: 'ext', tagText: '组员', time: '09:22', kind: 'unsupported', mtype: '视频', detail: '{ "msgType": "video", "duration": "12s", "size": "4.2MB", "sender": "王芳", "sentAt": "09:22" }（可查看可取得的原始明细，不假装已理解内容）' },
  { side: 'in', who: '张伟', tag: 'ext', tagText: '组员', time: '09:23', kind: 'image' },
]

export const SESSIONS = {
  real: {
    navTitle: '群任务：排查联调群反馈', time: '18分钟',
    head: { title: '群任务：排查联调群反馈', sub: '/ deepseek-harness · 标准模式' },
    statusBar: ['12 轮 · 22 步', 'LLM 12m22s', '工具调用 4m41s', '缓存命中 93%'],
    modelChip: 'GLM-5.3 Flash Default',
  },
  simA: {
    navTitle: '模拟：buyer_8848 尺码咨询', time: '模拟', sim: true, instance: 'sim-0117-a',
    buyer: 'buyer_8848', buyerLabel: '买家 buyer_8848', target: '潮流女装旗舰店', testedWs: 'merchant-cs', simUserWs: 'deepseek-harness',
    createdTargetKey: 'qn-all-dm', createdTargetLabel: '千牛 · 潮流女装旗舰店 · 全部单聊',
    simUserAsk: '模拟一位买家咨询卫衣尺码，验证客服工作区的接待配置',
    history: { file: 'buyer-history.jsonl', count: 42 },
    msgs: [
      { side: 'in', who: 'buyer_8848', tag: 'ext', tagText: '模拟买家', time: '刚刚', html: '你好，这件卫衣有 XL 吗？我是会员' },
      { side: 'out', who: '客服助手', tag: 'ai', tagText: 'AI · 被测', time: '刚刚', html: '您好，有的。会员可领 10 元券，需要帮您查库存吗？', status: 'delivered' },
      { side: 'out', who: '店主', tag: 'sim-inject', tagText: '本人 · 模拟注入', time: '刚刚', html: '（本人发言注入示例：XL 还剩 3 件）', status: 'delivered' },
    ],
    statusBar: ['3 轮 · 6 步', '一对一模拟实例', '消息不会进入真实 IM'],
    modelChip: 'kimi-k3 Default',
  },
  simB: {
    navTitle: '模拟：buyer_1024 退货咨询', time: '模拟', sim: true, instance: 'sim-0117-b',
    buyer: 'buyer_1024', buyerLabel: '买家 buyer_1024', target: '潮流女装旗舰店', testedWs: 'merchant-cs', simUserWs: 'deepseek-harness',
    createdTargetKey: 'qn-all-dm', createdTargetLabel: '千牛 · 潮流女装旗舰店 · 全部单聊',
    simUserAsk: '模拟一位买家咨询退货政策，验证客服工作区的接待配置',
    history: null,
    msgs: [
      { side: 'in', who: 'buyer_1024', tag: 'ext', tagText: '模拟买家', time: '1 分钟前', html: '想问下退货政策' },
      { side: 'out', who: '客服助手', tag: 'ai', tagText: 'AI · 被测', time: '1 分钟前', html: '您好，支持 7 天无理由退货。（同一目标的第二个并发实例：独立的模拟用户 Session，一对一，历史与上下文相互隔离）', status: 'delivered' },
    ],
    statusBar: ['2 轮 · 4 步', '一对一模拟实例', '消息不会进入真实 IM'],
    modelChip: 'glm-5.3 Default',
  },
  simC: {
    navTitle: '模拟：新买家咨询（未配置）', time: '模拟', sim: true, unconfigured: true, instance: null,
    simUserWs: 'merchant-cs-eval',
    msgs: [],
    statusBar: ['0 轮 · 0 步', '未配置 IM 通道模拟'],
    modelChip: 'kimi-k3 Default',
  },
}
