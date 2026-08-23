/** `browser` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'browser'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'dock.collapse': '收起浏览器',
  'dock.refresh': '刷新',
  'dock.refreshing': '正在刷新',
  'dock.address': '地址',
  'dock.sharedProfile': '共享身份',
  'dock.closeTab': '关闭标签页',
  'dock.empty': '没有打开的页面',
  'dock.start': '输入地址并回车',
  'dock.creating': '正在创建页面',
  'dock.invalidAddress': '无法打开该地址',
  'dock.actionFailed': '无法完成该操作',
  'preview.select': '切换到 {title}',
  'preview.open': '展开 {title}',
  'page.untitled': '无标题',
  'settings.nav': '浏览器',
  'settings.title': '浏览器 Profile',
  'settings.intro': '侧栏「+ → 浏览器」与省略 profile 的 browser_create 使用这里的默认身份。本页不会创建浏览器标签页。',
  'settings.defaultKind': '默认身份',
  'settings.kind.shared': '共享',
  'settings.kind.temporary': '临时',
  'settings.kind.persistent': '持久',
  'settings.defaultPersistentName': '默认持久名称',
  'settings.defaultPersistentName.empty': '未选择',
  'settings.roster': '持久 Profile 名册',
  'settings.roster.empty': '还没有命名 Profile',
  'settings.roster.add': '新名称',
  'settings.roster.submit': '添加',
  'settings.roster.remove': '删除',
  'settings.roster.invalid': '名称须为稳定分区键：字母或数字开头，不含 shared 或 tmp 前缀。',
} satisfies Record<string, string>

/** The browser namespace key union. */
export type BrowserKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'dock.collapse': 'Collapse browser',
  'dock.refresh': 'Refresh',
  'dock.refreshing': 'Refreshing',
  'dock.address': 'Address',
  'dock.sharedProfile': 'Shared identity',
  'dock.closeTab': 'Close tab',
  'dock.empty': 'No open pages',
  'dock.start': 'Enter an address and press Return',
  'dock.creating': 'Creating page',
  'dock.invalidAddress': 'Could not open that address',
  'dock.actionFailed': 'Could not complete that action',
  'preview.select': 'Switch to {title}',
  'preview.open': 'Expand {title}',
  'page.untitled': 'Untitled',
  'settings.nav': 'Browser',
  'settings.title': 'Browser Profile',
  'settings.intro': 'Sidebar + → Browser and browser_create calls that omit profile use this default identity. This page does not create a browser tab.',
  'settings.defaultKind': 'Default identity',
  'settings.kind.shared': 'Shared',
  'settings.kind.temporary': 'Temporary',
  'settings.kind.persistent': 'Persistent',
  'settings.defaultPersistentName': 'Default persistent name',
  'settings.defaultPersistentName.empty': 'None selected',
  'settings.roster': 'Persistent Profile roster',
  'settings.roster.empty': 'No named Profiles yet',
  'settings.roster.add': 'New name',
  'settings.roster.submit': 'Add',
  'settings.roster.remove': 'Remove',
  'settings.roster.invalid': 'The name must be a stable partition key: start with a letter or digit, and do not use shared or a tmp prefix.',
} satisfies Record<BrowserKey, string>
