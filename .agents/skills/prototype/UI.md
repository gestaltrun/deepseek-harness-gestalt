# UI Prototype

Generate **several interaction variants** of a new capability, each fused into the existing page and component library. The user flips between variants, picks one (or steals bits from each), then throws the rest away.

If the question is about logic/state rather than what something looks like, this is the wrong branch. Use [LOGIC.md](LOGIC.md).

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time a new function needs a concrete interaction draft inside the current chrome.

## Two sub-shapes: strongly prefer sub-shape A

A UI prototype is judged against the rest of the app: real header, real sidebar, real density, real components. A throwaway route on its own is a vacuum. Default to sub-shape A whenever there is a plausible existing page to host the variants. Only reach for sub-shape B if the prototype genuinely has no nearby home.

### Sub-shape A: adjustment to an existing page (preferred)

The route already exists, or the new function would naturally live inside one (a Settings section, an account-pool body, a card on a current screen). Variants render **on that same route**, gated by a `?variant=` URL search param. Keep the host page's data fetching, params, chrome, and component library. Swap only the new region's rendering. Mock the new function's data in memory when the live backend is not the question.

Edit the current page or section in place when that is the cheapest way to keep spacing, type, and chrome honest. Mark the prototype files so a reader can see they are not the production fold-in.

### Sub-shape B: a new page (last resort)

Only use this when the thing being prototyped genuinely has no existing page to live inside. Create a throwaway route that still mounts the product chrome (sidebar, Settings shell, Desktop overlay) and the same component library. Name it so it's obviously a prototype. Same `?variant=` pattern.

Before committing to sub-shape B, sanity-check: is there really no existing page this could be embedded in?

In both sub-shapes the floating switcher is identical, and it is **not** part of the visual draft.

## Process

### 1. State the question and pick N

Default to **3 variants**. More than 5 stops being different interactions and starts being noise: cap there.

Write down the plan in one line, in the prototype's location or a top-of-file comment:

> "Three interaction variants of the account-pool body, switchable via `?variant=`, on the existing Settings route, using current Desktop/Settings components."

This works whether the user is here to push back or not.

### 2. Generate structurally different, visually fused variants

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to.
- The host page's component library, spacing, type, and chrome. Reuse those components; do not invent a parallel kit.
- A clear exported component name, e.g. `VariantA`, `VariantB`, `VariantC`.

Variants must be **interaction-different**: different layout of the new function, different information hierarchy, different primary affordance: not just different colours. They must still look like the same product. Three slightly-tweaked card grids isn't a UI prototype. A variant that abandons the host chrome also isn't.

Captions, grilling notes, and arrows that explain the design stay out of the composition. The draft is only the high-fidelity page the user would ship.

### 3. Wire them together

Create a single switcher on the route:

```tsx
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A','B','C']} current={variant} />
  </>
);
```

For sub-shape A: keep all existing data fetching above the switcher; only the new region's subtree changes. Mock data for the new function is fine.

For sub-shape B: the throwaway route still wraps the product chrome, then mounts the same switcher.

### 4. Build the floating switcher

A small fixed-position bar at the bottom-centre with three pieces:

- **Left arrow**: cycles to the previous variant (wraps around).
- **Variant label**: current key and, if exported, the variant name. e.g. `B: Inline table`.
- **Right arrow**: cycles forward (wraps around).

Behaviour:

- Clicking an arrow updates the URL search param so the variant is shareable and reload-stable.
- Keyboard: `←` and `→` also cycle. Don't intercept arrow keys when an `<input>`, `<textarea>`, or `[contenteditable]` is focused.
- Visually distinct from the page so it is obviously not part of the draft.
- Hidden in production builds: gate on `process.env.NODE_ENV !== 'production'` or an equivalent check.

Put the switcher in a single shared component. Locate it wherever shared UI lives in the project.

### 5. Self-check headless, then ask for headed review

Follow [dsh-desktop-test-instance](../dsh-desktop-test-instance/SKILL.md):

1. Start one isolated instance headless, with mock data for the new function.
2. Walk every `?variant=` key. Confirm the host chrome is the real page, the new region uses existing components, and no caption or switcher sits inside the draft.
3. Only after that check passes, start a headed instance and ask the user to review. Surface the URL and the `?variant=` keys.

Do not open a headed window to decide whether the draft is ready.

### 6. Capture the answer and clean up

Once a variant has won, capture the answer (which variant and why), then capture the prototype the way the [SKILL](SKILL.md) describes. Fold the winner into the real code and move the rest onto the throwaway branch, not into main:

- **Sub-shape A**: fold the winner into the existing page; drop the losing variants and the switcher from main.
- **Sub-shape B**: promote the winning variant to a real route; drop the throwaway route and the switcher from main.

The full set of variants is the primary source, so it lands on the throwaway branch. Link that branch and the frozen screenshots or GIF from the specification; the spec cites the draft instead of restating the layout in prose.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype. Real variants disagree about interaction.
- **A parallel visual language.** New function, same product. Reuse the host page's components; do not restyle the chrome to make the idea clearer.
- **Narration inside the draft.** Callouts, grilling notes, and the switcher bar are scaffolding. The headed review shows only the high-fidelity page.
- **Headed-first self-review.** The agent checks headless; the user reviews headed.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it at a stub. The question is "how should this interact", not "does the backend work".
- **Promoting the prototype directly to production.** The variant code was written under prototype constraints. Rewrite it properly when you fold it in.
