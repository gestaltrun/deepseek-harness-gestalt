/** `member-question` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tag.remote': '远端',
  'role.owner': '所有者',
  'role.admin': '管理员',
  'role.member': '成员',
  'project.label': '项目',
  'session.label': '来源会话',
  'background.label': '背景',
  'references.label': '材料',
  'countdown.expired': '已过期',
  'collapsed.mark': '已收起',
  'collapsed.bar': '远端 · {name}',
  'origin.fallback': '成员',
  'record.answered': '已回答',
  'record.answered-elsewhere': '已在 {device} 回答',
  'record.declined': '已拒绝',
  'record.expired': '已过期',
  'record.withdrawn': '已撤回',
  'record.superseded': '已被新问题取代',
} satisfies Record<string, string>

/** The member-question namespace key union. */
export type MemberQuestionKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'tag.remote': 'Remote',
  'role.owner': 'Owner',
  'role.admin': 'Admin',
  'role.member': 'Member',
  'project.label': 'Project',
  'session.label': 'From session',
  'background.label': 'Background',
  'references.label': 'Materials',
  'countdown.expired': 'Expired',
  'collapsed.mark': 'Collapsed',
  'collapsed.bar': 'Remote · {name}',
  'origin.fallback': 'member',
  'record.answered': 'Answered',
  'record.answered-elsewhere': 'Answered on {device}',
  'record.declined': 'Declined',
  'record.expired': 'Expired',
  'record.withdrawn': 'Withdrawn',
  'record.superseded': 'Superseded by a newer question',
} satisfies Record<MemberQuestionKey, string>
