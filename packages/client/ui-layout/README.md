# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: three-column AppFrame (drag handles and concession chain) plus the `ctx.layout` panel-geometry service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, and `shell.overlay`. The sidebar resize boundary is an invisible hit strip, while the details boundary retains its floating pill; only details shrinks during concession and then auto-closes in-flow. A closed sidebar retains a 56px control rail; a closed details preference is zero width, while an open preference that cannot keep the Session Surface at 640px paints as a right overlay. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

AppFrame mounts the conversation and details columns except on the Desktop native-overlay document, which renders only `sidebar` so Settings can stack above official pages; a connected Session renders through `SessionProvider`. In Desktop composition, the macOS and Windows chrome markers offset the center Session column by 36px so the Session header stays below the frameless drag strip; browser composition keeps the default top edge. The transient layout store starts the sidebar at its default width and details closed, and it never reads or writes `localStorage`. A details occupant opens through `ctx.layout.openDetails({ minimum, default, maximum })`; omitting the range preserves ordinary details geometry at 300/360/520px, while an occupant may declare a 960px maximum. Repeating the active range preserves an open dragged width, changing the range adopts the new default, and close followed by reopen restores that active default. The concession solver clamps to the active range, shrinks details to its minimum while retaining the 640px Session Surface minimum, then derives an automatic in-flow close without rewriting the stored preference. When that preference is still open, AppFrame paints the occupant as a right-edge overlay over the Session Surface so collapse chrome stays reachable. Hero and other unselected states likewise derive a zero in-flow details width without changing that preference. AppFrame retains the last non-blank Session id across those states: the first Session remains closed, returning to the same Session restores its unchanged width, and selecting a different Session closes details before paint. The conversation owner share is empty, while the sidebar owner share contains only `collapsed` and `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, `DetailsWidthRange`, and the owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default and details closed; switching between distinct Session ids also closes details and forgets its dragged width, while unselected surfaces render details at zero width without modifying geometry.
- **Concession-chain auto-close derives a zero in-flow width without touching the preferred width** — an open preference still paints as a right overlay; widening the window restores the in-flow track; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
