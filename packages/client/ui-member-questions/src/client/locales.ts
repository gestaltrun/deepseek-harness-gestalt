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
} satisfies Record<MemberQuestionKey, string>
