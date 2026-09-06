// 正式组件的统一引用点：只从正式包 re-export，便于 manifest 审计「直接复用」清单。
export {
  Button, Input, Modal, StateDot, Pill, Menu, Tooltip, Toast as FormalToast,
  IconCheckOutline14, IconCheckOutline16, IconCloseOutline16, IconPlusOutline16, IconSearchOutline16,
  IconSettingsOutline16, IconSendOutline14, IconSendOutline16, IconFolderOpen16,
  IconUserOutline16, IconSparkle16, IconGlobeOutline14, IconNewChatOutline16,
  IconEditOutline16, IconTrashOutline16, IconWarningOutline16, IconStopFill16,
  IconPanelLeftOutline16, IconRefreshOutline14, IconLinkOutline14, IconSkillOutline16,
  IconCodeOutline16, IconGoalOutline16, IconListPenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

// 下列语义图标在正式导出清单中无同名项，以近似正式图标适配（manifest 标注「适配」）。
export {
  IconWarningOutline16 as IconAlertOutline16,
  IconEditOutline16 as IconWrenchOutline16,
  IconFolderOpen16 as IconImageOutline16,
  IconRefreshOutline14 as IconSwapOutline14,
  IconSkillOutline16 as IconFlaskOutline16,
  IconPanelLeftOutline16 as IconCollapseOutline16,
  IconUserOutline16 as IconPuzzleOutline16,
  IconSparkle16 as IconPhoneOutline16,
  IconGlobeOutline14 as IconCardOutline16,
  IconSettingsOutline16 as IconGearOutline16,
  IconNewChatOutline16 as IconChatOutline16,
  IconLinkOutline14 as IconExternalOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
