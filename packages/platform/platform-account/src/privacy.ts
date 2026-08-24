/** Bilingual retention notice every installation displays before authorization. */
export const ACCOUNT_PRIVACY_NOTICE = {
  zh: 'Platform 会保存 GitHub 数字 ID、公开登录名与头像，以及安装和配对元数据。原始 IP 日志最多保留 7 天，非内容安全事件最多保留 30 天；加密附件只在传输所需的短期内保留。首个版本不提供账号删除；退出登录只撤销当前安装，不删除个人配对。',
  en: 'Platform stores the numeric GitHub id, public login and avatar, plus installation and pairing metadata. Raw IP logs are retained for at most 7 days, content-free security events for at most 30 days, and encrypted attachment blobs only for the short transfer lifetime. The first version does not provide account deletion; signing out revokes only this installation and does not delete Personal Pairings.',
} as const
