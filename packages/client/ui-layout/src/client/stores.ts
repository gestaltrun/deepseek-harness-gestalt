/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook. The
 * active details range is transient viewing state beside its preferred width.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  clampWidth, DEFAULT_DETAILS_WIDTH_RANGE,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'
import type { DetailsWidthRange } from './details-width.ts'

/**
 * Layout store state: panel width preferences in px (0 = closed), the active
 * details occupant range, plus the narrow-viewport pair — `narrow` mirrors
 * AppFrame's breakpoint reading (viewport < SIDEBAR_AUTO_COLLAPSE) so
 * toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
type LayoutState = {
  sidebar: number
  details: number
  detailsRange: DetailsWidthRange
  narrow: boolean
  narrowExpanded: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState, range?: DetailsWidthRange) => void
  closeDetails: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: sidebar and details drag writes
 * clamp into their active ranges and never cross the open/closed line.
 * Opening a different details range adopts its default; reopening the
 * same range preserves an open dragged width, while close followed by open
 * writes 0 / that range's default explicitly. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  const handle = defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      detailsRange: { ...DEFAULT_DETAILS_WIDTH_RANGE },
      narrow: false,
      narrowExpanded: false,
    }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => {
        d.details = clampWidth(px, d.detailsRange.minimum, d.detailsRange.maximum)
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d, range: DetailsWidthRange = DEFAULT_DETAILS_WIDTH_RANGE) => {
        const changed = d.detailsRange.minimum !== range.minimum
          || d.detailsRange.default !== range.default
          || d.detailsRange.maximum !== range.maximum
        d.detailsRange = { ...range }
        if (d.details === 0 || changed) d.details = range.default
      },
      closeDetails: (d) => { d.details = 0 },
    },
  })
  return handle
}
